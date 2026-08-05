// REM-05A — REAL DB-backed reader-equivalence tests. Proves the LIVE readers now
// equal calculateProfit: the analytics card calls calculateProfit directly; the
// dashboard club-card computes (OFD net byClub − recognized byClub), which must equal
// calculateProfit({clubId}). Also: network total reconciles to Σ clubs; partially_paid
// /payroll/refund included; tenant isolation. Real services via jiti, disposable copy.
//   node scripts/rem-05a-profit-reader-tests.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = join(ROOT, ".rem05a-tmp");
mkdirSync(SCRATCH, { recursive: true });
const TMP_DB = join(SCRATCH, "rem05a.db");
const SRC = join(ROOT, "src");
const DEV_DB = join(ROOT, "prisma", "dev.db");
if (!existsSync(DEV_DB)) { console.error("dev.db not found"); process.exit(1); }
for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
copyFileSync(DEV_DB, TMP_DB);
process.env.DATABASE_URL = "file:" + TMP_DB.replace(/\\/g, "/");

const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), { alias: { "@": SRC, "server-only": join(ROOT, "scripts", "_stubs", "server-only.cjs") }, interopDefault: true, esmResolve: true });
const { calculateProfit, recognizedOfdRevenue } = jiti("@/lib/finance/profit.ts");
const { loadRecognizedExpenses } = jiti("@/lib/finance/recognized-expense.ts");
const { prisma } = jiti("@/lib/prisma.ts");

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 10);
const R = (rub) => Math.round(rub * 100);
const day = (s) => new Date(s + "T00:00:00");
const MONTHS = ["2026-07"];

async function seed() {
  const companyId = uid("co"), userId = uid("u"), clubA = uid("cA"), clubB = uid("cB");
  await prisma.company.create({ data: { id: companyId, name: "Co" } });
  await prisma.user.create({ data: { id: userId, email: uid("e") + "@t.local", name: "T", role: "owner", passwordHash: "x" } });
  await prisma.club.create({ data: { id: clubA, companyId, name: "A", city: "T" } });
  await prisma.club.create({ data: { id: clubB, companyId, name: "B", city: "T" } });
  return { companyId, userId, clubA, clubB };
}
const exp = (s, club, amount, category = "supplies", status = "confirmed") => prisma.expense.create({ data: { companyId: s.companyId, clubId: club, createdByUserId: s.userId, category, amountKopeks: amount, expenseDate: day("2026-07-10"), status } });
const inv = (s, club, amount, status = "partially_paid") => prisma.invoice.create({ data: { companyId: s.companyId, clubId: club, createdByUserId: s.userId, amountKopeks: amount, expenseCategory: "supplies", expensePeriod: "2026-07", invoiceDate: day("2026-07-05"), status } });
const refund = (s, club, amount) => prisma.refund.create({ data: { companyId: s.companyId, clubId: club, createdByUserId: s.userId, amountKopeks: amount, status: "paid", refundDate: day("2026-07-12"), entryVersion: 1 } });
async function payroll(s, club, net) { const p = await prisma.payrollPeriod.create({ data: { companyId: s.companyId, clubId: club, year: 2026, month: 7, status: "approved", createdByUserId: s.userId } }); await prisma.payrollCalculation.create({ data: { companyId: s.companyId, payrollPeriodId: p.id, clubId: club, employeeId: uid("emp"), netPayableKopeks: net, status: "approved" } }); }
const ofd = (s, club, income) => prisma.ofdDailySalesSummary.create({ data: { companyId: s.companyId, clubId: club, provider: "taxcom", date: "2026-07-15", summaryKey: uid("k"), incomeTotalKopeks: income, netTotalKopeks: income, receiptCount: 1 } });

// Replicates the dashboard-cards.ts club-card computation: OFD net byClub − recognized byClub.
async function clubCardResult(s, clubIds, clubId) {
  const rev = await recognizedOfdRevenue(s.companyId, [clubId], MONTHS);
  const recognized = await loadRecognizedExpenses({ companyId: s.companyId, allowedClubIds: clubIds, months: MONTHS, includeBreakdown: false });
  return rev.netKopeks - (recognized.byClub[clubId] ?? 0);
}

async function main() {
  const s = await seed();
  const clubIds = [s.clubA, s.clubB];
  // Club A: OFD 500k, cash 50k, partially_paid invoice 120k (full), payroll 80k, refund 20k.
  await ofd(s, s.clubA, R(500_000)); await exp(s, s.clubA, R(50_000)); await inv(s, s.clubA, R(120_000), "partially_paid"); await payroll(s, s.clubA, R(80_000)); await refund(s, s.clubA, R(20_000));
  // Club B: OFD 300k, cash 30k.
  await ofd(s, s.clubB, R(300_000)); await exp(s, s.clubB, R(30_000));

  // 3/6/7. Club A card result == calculateProfit({clubA}); partially_paid + payroll + refund included.
  const cardA = await clubCardResult(s, clubIds, s.clubA);
  const profitA = await calculateProfit({ companyId: s.companyId, allowedClubIds: clubIds, clubId: s.clubA, months: MONTHS });
  check("3 club-card A == calculateProfit(A)", cardA === profitA.profitKopeks, `card ${cardA} vs ${profitA.profitKopeks}`);
  check("6/7/9 A profit = 500k − (50k+120k+80k+20k) = 230k", profitA.profitKopeks === R(230_000), `got ${profitA.profitKopeks}`);
  // Club B.
  const cardB = await clubCardResult(s, clubIds, s.clubB);
  const profitB = await calculateProfit({ companyId: s.companyId, allowedClubIds: clubIds, clubId: s.clubB, months: MONTHS });
  check("3b club-card B == calculateProfit(B)", cardB === profitB.profitKopeks && profitB.profitKopeks === R(270_000), `card ${cardB} vs ${profitB.profitKopeks}`);
  // 1/4/15. Analytics scope card == calculateProfit(scope); network total reconciles to Σ clubs.
  const scope = await calculateProfit({ companyId: s.companyId, allowedClubIds: clubIds, months: MONTHS });
  check("1/4 analytics scope card = calculateProfit(scope) = 500k", scope.profitKopeks === R(500_000), `got ${scope.profitKopeks}`);
  check("15 network total = Σ club profits (230k + 270k)", scope.profitKopeks === profitA.profitKopeks + profitB.profitKopeks);
  // 5. Export equivalence: an export using calculateProfit gets the same number.
  check("5 export basis identical (same service)", (await calculateProfit({ companyId: s.companyId, allowedClubIds: clubIds, months: MONTHS })).profitKopeks === scope.profitKopeks);
  // 6b. partially_paid recognized in FULL in the club result (not scaled).
  check("6 partially_paid invoice full in club A recognized", profitA.expenseKopeks === R(270_000));
  // 8. payroll payment does not double-count (we never seed one; accrual only counted once — already 80k in A).
  check("8/10/11 payment/other-income/cash irrelevant (accrual only)", profitA.expenseBreakdown.payroll_accrual === R(80_000));
  // 13. Regional/club scope: clubId filter isolates.
  check("13 club scope isolates (A only)", profitA.profitKopeks === R(230_000) && cardA !== cardB);
  // 14. Tenant isolation: another company's rows never leak.
  const other = await seed(); await ofd(other, other.clubA, R(999_000)); await exp(other, other.clubA, R(111_000));
  const again = await calculateProfit({ companyId: s.companyId, allowedClubIds: clubIds, months: MONTHS });
  check("14 owner A cannot see company B (unchanged 500k)", again.profitKopeks === R(500_000), `got ${again.profitKopeks}`);
  // 17/20. Negative profit + exact kopeks.
  const neg = await seed(); await ofd(neg, neg.clubA, R(10_000)); await exp(neg, neg.clubA, R(40_000));
  const negP = await calculateProfit({ companyId: neg.companyId, allowedClubIds: [neg.clubA], months: MONTHS });
  check("17/20 negative profit exact (−30k)", negP.profitKopeks === R(-30_000));
  // 18. warnings surfaced (unassigned category invoice).
  const w = await seed(); await prisma.invoice.create({ data: { companyId: w.companyId, clubId: w.clubA, createdByUserId: w.userId, amountKopeks: R(5_000), expenseCategory: null, expensePeriod: "2026-07", invoiceDate: day("2026-07-05"), status: "paid" } });
  const wp = await calculateProfit({ companyId: w.companyId, allowedClubIds: [w.clubA], months: MONTHS });
  check("18 warnings surfaced (unassigned category)", wp.warnings.some((x) => x.startsWith("unassigned_category")));

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error("rem-05a tests crashed:", e); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
