// REM-02 — READ-ONLY cash-cutover preflight (§20). SELECT-only; NO writes. Run on dev or a production
// READ REPLICA before setting a company's cutover. Detects duplicate active snapshots, broken correction
// chains, cancelled-snapshot influence, ООО cash expenses (rule-B violation), cross-tenant rows, and
// legacy/canonical divergence signals.
//   node --env-file=.env scripts/preflight-cash-cutover.mjs [--json]
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
const results = [];
const rec = (id, title, sev, count, sample = []) => results.push({ id, title, severity: sev, offendingRows: count, sample: sample.slice(0, 10) });
const safe = async (id, title, sev, fn) => { try { await fn(id, title, sev); } catch (e) { results.push({ id, title, severity: sev, error: String(e.message || e).slice(0, 200), offendingRows: null }); } };

async function main() {
  // 1. Duplicate ACTIVE snapshots per (club, legalEntity, snapshotDate day).
  await safe("CC-01", "duplicate ACTIVE BalanceSnapshot per (club, legalEntity, date)", "S1", async (id, t, s) => {
    const snaps = await prisma.balanceSnapshot.findMany({ where: { status: "active" }, select: { id: true, clubId: true, legalEntityId: true, snapshotDate: true } });
    const seen = new Map(); let bad = 0; const sample = [];
    for (const x of snaps) { const k = `${x.clubId}|${x.legalEntityId}|${new Date(x.snapshotDate).toISOString().slice(0, 10)}`; if (seen.has(k)) { bad++; if (sample.length < 10) sample.push(k); } else seen.set(k, x.id); }
    rec(id, t, s, bad, sample);
  });
  // 2. Broken correction chains: supersedesSnapshotId → missing snapshot.
  await safe("CC-02", "broken correction chain (supersedesSnapshotId → missing row)", "S2", async (id, t, s) => {
    const snaps = await prisma.balanceSnapshot.findMany({ select: { id: true, supersedesSnapshotId: true } });
    const ids = new Set(snaps.map((x) => x.id)); let bad = 0; const sample = [];
    for (const x of snaps) { if (x.supersedesSnapshotId && !ids.has(x.supersedesSnapshotId)) { bad++; if (sample.length < 10) sample.push(x.id); } }
    rec(id, t, s, bad, sample);
  });
  // 3. Superseded/cancelled row still marked active by an old reader — n/a post-fix; count active rows that supersede another active row.
  await safe("CC-03", "an ACTIVE snapshot that supersedes a still-ACTIVE snapshot (correction chain not flipped)", "S2", async (id, t, s) => {
    const actives = await prisma.balanceSnapshot.findMany({ where: { status: "active", supersedesSnapshotId: { not: null } }, select: { id: true, supersedesSnapshotId: true } });
    const activeIds = new Set((await prisma.balanceSnapshot.findMany({ where: { status: "active" }, select: { id: true } })).map((x) => x.id));
    let bad = 0; const sample = [];
    for (const x of actives) { if (activeIds.has(x.supersedesSnapshotId)) { bad++; if (sample.length < 10) sample.push(x.id); } }
    rec(id, t, s, bad, sample);
  });
  // 4. ООО cash expenses (rule-B violation): an Expense with paymentMethod=cash on an ООО legal entity.
  await safe("CC-04", "ООО cash expense exists (violates rule B: cash is ИП-only)", "S2", async (id, t, s) => {
    const oooIds = new Set((await prisma.legalEntity.findMany({ where: { type: "ooo" }, select: { id: true } })).map((e) => e.id));
    const cashExp = await prisma.expense.findMany({ where: { paymentMethod: "cash", legalEntityId: { not: null } }, select: { id: true, legalEntityId: true } });
    let bad = 0; const sample = [];
    for (const e of cashExp) { if (oooIds.has(e.legalEntityId)) { bad++; if (sample.length < 10) sample.push(e.id); } }
    rec(id, t, s, bad, sample);
  });
  // 5. Cross-tenant snapshot: snapshot.companyId ≠ its club's companyId.
  await safe("CC-05", "BalanceSnapshot.companyId ≠ its club.companyId", "S1", async (id, t, s) => {
    const clubCo = new Map((await prisma.club.findMany({ select: { id: true, companyId: true } })).map((c) => [c.id, c.companyId]));
    const snaps = await prisma.balanceSnapshot.findMany({ select: { id: true, companyId: true, clubId: true } });
    let bad = 0; const sample = [];
    for (const x of snaps) { if (clubCo.has(x.clubId) && clubCo.get(x.clubId) !== x.companyId) { bad++; if (sample.length < 10) sample.push(x.id); } }
    rec(id, t, s, bad, sample);
  });
  // 6. Future-dated active snapshots (would be excluded by the ≤now cutoff — flag anomalies).
  await safe("CC-06", "future-dated ACTIVE snapshot (excluded by the resolver; verify intent)", "S3", async (id, t, s) => {
    const rows = await prisma.balanceSnapshot.findMany({ where: { status: "active", snapshotDate: { gt: new Date() } }, select: { id: true } });
    rec(id, t, s, rows.length, rows.slice(0, 10).map((r) => r.id));
  });
  // 7. Legacy CashMovement rows exist (informational — historical; not deleted).
  await safe("CC-07", "legacy CashMovement rows present (kept for history; not the official balance)", "S3", async (id, t, s) => {
    const n = await prisma.cashMovement.count();
    rec(id, t, s, n, []);
  });
  // 8. Companies with a cutover already set (informational).
  await safe("CC-08", "companies with cashCanonicalCutoverAt set", "S3", async (id, t, s) => {
    const n = await prisma.company.count({ where: { cashCanonicalCutoverAt: { not: null } } });
    rec(id, t, s, n, []);
  });
  // 9. Legacy CashMovement written AFTER a company's cutover (a double-write defect).
  await safe("CC-09", "legacy CashMovement created after the company cutover (double-write defect)", "S1", async (id, t, s) => {
    const cos = await prisma.company.findMany({ where: { cashCanonicalCutoverAt: { not: null } }, select: { id: true, cashCanonicalCutoverAt: true } });
    let bad = 0; const sample = [];
    for (const c of cos) { const n = await prisma.cashMovement.findMany({ where: { companyId: c.id, createdAt: { gte: c.cashCanonicalCutoverAt } }, select: { id: true }, take: 10 }); bad += n.length; for (const m of n) if (sample.length < 10) sample.push(m.id); }
    rec(id, t, s, bad, sample);
  });
  // 10. Snapshot without legal entity type resolvable (orphan LE).
  await safe("CC-10", "BalanceSnapshot.legalEntityId → missing LegalEntity", "S2", async (id, t, s) => {
    const leIds = new Set((await prisma.legalEntity.findMany({ select: { id: true } })).map((e) => e.id));
    const snaps = await prisma.balanceSnapshot.findMany({ select: { id: true, legalEntityId: true } });
    let bad = 0; const sample = [];
    for (const x of snaps) { if (!leIds.has(x.legalEntityId)) { bad++; if (sample.length < 10) sample.push(x.id); } }
    rec(id, t, s, bad, sample);
  });

  const total = results.reduce((a, r) => a + (r.offendingRows || 0), 0);
  const report = { generatedAt: "db-read-only", checks: results.length, totalOffendingRows: total, results };
  mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true });
  writeFileSync(join(ROOT, "docs/audits/data/cash-cutover-preflight.json"), JSON.stringify(report, null, 2));
  if (!JSON_ONLY) {
    console.log("=== Cash-cutover preflight (READ-ONLY, no writes) ===");
    for (const r of results) console.log(`${r.offendingRows === 0 ? "OK  " : r.error ? "ERR " : "FLAG"} ${r.id} [${r.severity}] ${r.title}${r.offendingRows ? ` → ${r.offendingRows}` : ""}${r.error ? " :: " + r.error : ""}`);
    console.log(`\n${results.length} checks · ${total} offending rows`);
    console.log("NOTE: CC-07 legacy rows are EXPECTED (kept for history). A clean DEV result does not prove production — run on a replica.");
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
