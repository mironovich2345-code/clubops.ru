// REM-02 — REAL DB-backed integration tests (§22). Imports & EXECUTES the actual resolver
// (resolveCashBalance) + the shared snapshot rule + the cutover guard (via jiti) against a DISPOSABLE
// sqlite copy of the real schema. Asserts the actual rows/numbers — not mirrors, not source strings.
//   node scripts/rem-02-cash-source-integration.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = process.env.CLUBOPS_SCRATCH || join(ROOT, ".rem02-tmp");
mkdirSync(SCRATCH, { recursive: true });
const TMP_DB = join(SCRATCH, "rem02-cash.db");
const SRC = join(ROOT, "src");
const DEV_DB = join(ROOT, "prisma", "dev.db");
if (!existsSync(DEV_DB)) { console.error("dev.db not found"); process.exit(1); }
for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
copyFileSync(DEV_DB, TMP_DB);
process.env.DATABASE_URL = "file:" + TMP_DB.replace(/\\/g, "/");

const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), { alias: { "@": SRC, "server-only": join(ROOT, "scripts", "_stubs", "server-only.cjs") }, interopDefault: true, esmResolve: true });
const { resolveCashBalance } = jiti("@/lib/cash-resolver.ts");
const { resolveActiveSnapshots } = jiti("@/lib/cash-snapshot-resolver.ts");
const { legacyCashWriteDisabled } = jiti("@/lib/cash-wallets.ts");
const { prisma } = jiti("@/lib/prisma.ts");

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 10);
const day = (s) => new Date(s + "T00:00:00");

async function seedClub() {
  const companyId = uid("co"), clubId = uid("club"), ipId = uid("ip"), oooId = uid("ooo"), userId = uid("u");
  await prisma.company.create({ data: { id: companyId, name: "REM02 Co" } });
  await prisma.user.create({ data: { id: userId, email: uid("e") + "@t.local", name: "T", role: "accountant", passwordHash: "x" } });
  await prisma.club.create({ data: { id: clubId, companyId, name: "Club", city: "Town" } });
  await prisma.legalEntity.create({ data: { id: ipId, companyId, name: "ИП", type: "ip", inn: uid("i") } });
  await prisma.legalEntity.create({ data: { id: oooId, companyId, name: "ООО", type: "ooo", inn: uid("o") } });
  await prisma.clubLegalEntity.create({ data: { clubId, legalEntityId: ipId, isPrimary: true, isActive: true } });
  await prisma.clubLegalEntity.create({ data: { clubId, legalEntityId: oooId, isActive: true } });
  return { companyId, clubId, ipId, oooId, userId };
}
const snap = (s, leId, amount, date, status = "active", extra = {}) =>
  prisma.balanceSnapshot.create({ data: { companyId: s.companyId, clubId: s.clubId, legalEntityId: leId, actualBalanceKopeks: amount, snapshotDate: day(date), status, createdById: s.userId, ...extra } });

async function main() {
  // 1. Snapshot-only → exact IP balance.
  { const s = await seedClub(); await snap(s, s.ipId, 500000, "2026-07-01");
    const r = await resolveCashBalance({ companyId: s.companyId, clubId: s.clubId, asOf: day("2026-07-10") });
    check("1 snapshot-only → exact ИП balance", r.ip.balanceKopeks === 500000 && r.ip.snapshotSet === true, `got ${r.ip.balanceKopeks}`); }
  // 2. Cancelled snapshot ignored → previous active governs.
  { const s = await seedClub(); await snap(s, s.ipId, 100000, "2026-07-01"); await snap(s, s.ipId, 999999, "2026-07-05", "cancelled");
    const r = await resolveCashBalance({ companyId: s.companyId, clubId: s.clubId, asOf: day("2026-07-10") });
    check("2 cancelled snapshot ignored (uses 100000 not 999999)", r.ip.balanceKopeks === 100000, `got ${r.ip.balanceKopeks}`); }
  // 3. Corrected (superseded old + new active) → new active selected.
  { const s = await seedClub(); const old = await snap(s, s.ipId, 100000, "2026-07-01", "superseded"); await snap(s, s.ipId, 250000, "2026-07-01", "active", { version: 2, supersedesSnapshotId: old.id });
    const r = await resolveCashBalance({ companyId: s.companyId, clubId: s.clubId, asOf: day("2026-07-10") });
    check("3 corrected snapshot → new active selected (250000)", r.ip.balanceKopeks === 250000, `got ${r.ip.balanceKopeks}`); }
  // 4. Backdated snapshot affects only the subsequent interval (later active still wins).
  { const s = await seedClub(); await snap(s, s.ipId, 300000, "2026-07-05"); await snap(s, s.ipId, 111111, "2026-07-02"); // backdated earlier
    const r = await resolveCashBalance({ companyId: s.companyId, clubId: s.clubId, asOf: day("2026-07-10") });
    check("4 backdated earlier point does not override the later active (300000)", r.ip.balanceKopeks === 300000, `got ${r.ip.balanceKopeks}`); }
  // 5. Future-dated snapshot ignored at an earlier asOf.
  { const s = await seedClub(); await snap(s, s.ipId, 400000, "2026-07-01"); await snap(s, s.ipId, 888888, "2026-08-01");
    const r = await resolveCashBalance({ companyId: s.companyId, clubId: s.clubId, asOf: day("2026-07-10") });
    check("5 future snapshot ignored at asOf 07-10 (400000)", r.ip.balanceKopeks === 400000, `got ${r.ip.balanceKopeks}`); }
  // 6. asOf historical: pick the point governing that date.
  { const s = await seedClub(); await snap(s, s.ipId, 100000, "2026-06-01"); await snap(s, s.ipId, 700000, "2026-07-01");
    const rJun = await resolveCashBalance({ companyId: s.companyId, clubId: s.clubId, asOf: day("2026-06-15") });
    const rJul = await resolveCashBalance({ companyId: s.companyId, clubId: s.clubId, asOf: day("2026-07-15") });
    check("6 asOf historical balance correct (Jun=100000, Jul=700000)", rJun.ip.balanceKopeks === 100000 && rJul.ip.balanceKopeks === 700000, `${rJun.ip.balanceKopeks}/${rJul.ip.balanceKopeks}`); }
  // 7. Shared resolver returns the same governing snapshot as resolveCashBalance.
  { const s = await seedClub(); await snap(s, s.ipId, 100000, "2026-07-01"); await snap(s, s.ipId, 200000, "2026-07-05");
    const m = await resolveActiveSnapshots({ clubIds: [s.clubId], asOf: day("2026-07-10") }, prisma);
    const gov = m.get(`${s.clubId}|${s.ipId}`);
    check("7 shared resolveActiveSnapshots picks the latest active (200000)", gov?.actualBalanceKopeks === 200000, `got ${gov?.actualBalanceKopeks}`); }
  // 8. ООО snapshot-only balance.
  { const s = await seedClub(); await snap(s, s.oooId, 800000, "2026-07-01");
    const r = await resolveCashBalance({ companyId: s.companyId, clubId: s.clubId, asOf: day("2026-07-10") });
    check("8 ООО snapshot-only balance exact (800000)", r.ooo.balanceKopeks === 800000, `got ${r.ooo.balanceKopeks}`); }
  // 9. No snapshot → warning, no fabricated opening.
  { const s = await seedClub();
    const r = await resolveCashBalance({ companyId: s.companyId, clubId: s.clubId, asOf: day("2026-07-10") });
    check("9 no snapshot → snapshotSet=false + warning (no invented opening)", r.ip.snapshotSet === false && r.ip.warnings.length > 0 && r.ip.snapshotKopeks === 0); }
  // 10. Cutover guard: legacyCashWriteDisabled reflects the company setting.
  { const s = await seedClub();
    const before = await legacyCashWriteDisabled(s.companyId, prisma);
    await prisma.company.update({ where: { id: s.companyId }, data: { cashCanonicalCutoverAt: day("2026-07-01") } });
    const after = await legacyCashWriteDisabled(s.companyId, prisma);
    check("10 cutover guard: disabled=false before, true after the cutover is set", before === false && after === true, `${before}/${after}`); }
  // 11. Legacy wallet divergence does NOT alter the official balance (resolver never reads CashMovement).
  { const s = await seedClub(); await snap(s, s.ipId, 500000, "2026-07-01");
    const w = await prisma.cashWallet.create({ data: { companyId: s.companyId, clubId: s.clubId, legalEntityId: s.ipId, type: "club_cash", holderUserId: null } });
    await prisma.cashMovement.create({ data: { companyId: s.companyId, clubId: s.clubId, legalEntityId: s.ipId, type: "opening_balance", amountKopeks: 42, toWalletId: w.id, status: "confirmed", occurredAt: day("2026-07-02"), createdByUserId: s.userId } });
    const r = await resolveCashBalance({ companyId: s.companyId, clubId: s.clubId, asOf: day("2026-07-10") });
    check("11 legacy wallet row does NOT change the official ИП balance (still 500000)", r.ip.balanceKopeks === 500000, `got ${r.ip.balanceKopeks}`); }
  // 12. Tenant isolation: another company's snapshot never leaks into this club's balance.
  { const a = await seedClub(); const b = await seedClub(); await snap(a, a.ipId, 500000, "2026-07-01"); await snap(b, b.ipId, 123456, "2026-07-01");
    const r = await resolveCashBalance({ companyId: a.companyId, clubId: a.clubId, asOf: day("2026-07-10") });
    check("12 tenant isolation (company A sees 500000, not B's 123456)", r.ip.balanceKopeks === 500000, `got ${r.ip.balanceKopeks}`); }
  // 13. formulaVersion pinned.
  { const s = await seedClub(); const r = await resolveCashBalance({ companyId: s.companyId, clubId: s.clubId });
    check("13 resolver reports the formula version", r.formulaVersion === "rem-02.v1"); }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
  if (fail) process.exit(1);
}
main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true }); process.exit(1); });
