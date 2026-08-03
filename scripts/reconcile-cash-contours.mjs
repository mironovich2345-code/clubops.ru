// REM-02 — READ-ONLY cash-contour reconciliation (§17). Compares the OFFICIAL canonical balance
// (resolveCashBalance) against the LEGACY wallet balance (Σ confirmed CashMovement) per club+entity, and
// reports the difference + probable causes. NO writes. Uses jiti to run the real resolver. The canonical
// number is authoritative; legacy is shown only to explain historical divergence.
//   node --env-file=.env scripts/reconcile-cash-contours.mjs [--company=<id>] [--club=<id>] [--json]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const JSON_ONLY = process.argv.includes("--json");
const argOf = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || "").split("=")[1] || null;
const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), { alias: { "@": SRC, "server-only": join(ROOT, "scripts", "_stubs", "server-only.cjs") }, interopDefault: true, esmResolve: true });
const { resolveCashBalance } = jiti("@/lib/cash-resolver.ts");
const { prisma } = jiti("@/lib/prisma.ts");

async function legacyWalletBalances(clubId) {
  // Read-only: sum confirmed CashMovement per wallet → legalEntity, WITHOUT creating any wallet.
  const wallets = await prisma.cashWallet.findMany({ where: { clubId, type: "club_cash" }, select: { id: true, legalEntityId: true } });
  const byLe = new Map();
  for (const w of wallets) {
    const [inn, out] = await Promise.all([
      prisma.cashMovement.aggregate({ where: { toWalletId: w.id, status: "confirmed" }, _sum: { amountKopeks: true } }),
      prisma.cashMovement.aggregate({ where: { fromWalletId: w.id, status: "confirmed" }, _sum: { amountKopeks: true } }),
    ]);
    byLe.set(w.legalEntityId, (byLe.get(w.legalEntityId) || 0) + (inn._sum.amountKopeks ?? 0) - (out._sum.amountKopeks ?? 0));
  }
  return byLe;
}

async function main() {
  const companyId = argOf("company");
  const clubFilter = argOf("club");
  const clubs = await prisma.club.findMany({ where: { ...(companyId ? { companyId } : {}), ...(clubFilter ? { id: clubFilter } : {}), isActive: true }, select: { id: true, companyId: true, name: true } });
  const rows = [];
  let diverged = 0;
  for (const c of clubs) {
    const canon = await resolveCashBalance({ companyId: c.companyId, clubId: c.id });
    const legacy = await legacyWalletBalances(c.id);
    for (const ent of [canon.ip, canon.ooo]) {
      if (!ent.legalEntityId) continue;
      const legacyKopeks = legacy.get(ent.legalEntityId) ?? null; // ООО normally has no wallet → null
      const diff = legacyKopeks === null ? null : ent.balanceKopeks - legacyKopeks;
      if (diff !== null && diff !== 0) diverged++;
      rows.push({
        club: c.name, clubId: c.id, entityType: ent.entityType, legalEntityId: ent.legalEntityId,
        canonicalKopeks: ent.balanceKopeks, legacyWalletKopeks: legacyKopeks, differenceKopeks: diff,
        snapshotSet: ent.snapshotSet,
        probableCause: legacyKopeks === null ? "no legacy wallet (expected for ООО / pre-wallet)" : diff === 0 ? "match" : "double-write / OFD-since-snapshot / status-semantics (canonical is authoritative)",
      });
    }
  }
  const report = { generatedAt: "db-read-only", formulaVersion: "rem-02.v1", clubs: clubs.length, entities: rows.length, diverged, rows, note: "The canonical (formula) balance is the OFFICIAL figure. Legacy wallet differences are historical and never overwrite the official balance; remediate via the safe reconciliation plan, never a destructive edit." };
  mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true });
  writeFileSync(join(ROOT, "docs/audits/data/cash-contours-reconciliation.json"), JSON.stringify(report, null, 2));
  if (!JSON_ONLY) {
    console.log("=== Cash-contour reconciliation (READ-ONLY; canonical = official) ===");
    for (const r of rows) console.log(`${r.differenceKopeks === 0 ? "OK  " : r.differenceKopeks === null ? "--  " : "DIFF"} ${r.club} ${r.entityType.toUpperCase()}: canonical=${r.canonicalKopeks} legacy=${r.legacyWalletKopeks ?? "n/a"} diff=${r.differenceKopeks ?? "n/a"} (${r.probableCause})`);
    console.log(`\n${clubs.length} clubs · ${rows.length} entities · ${diverged} diverged. Canonical is authoritative; legacy is history only.`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
