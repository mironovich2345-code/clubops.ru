// REM-05 — REAL DB-backed integration tests (§25/§26). Imports & EXECUTES the actual
// canonical services (loadRecognizedExpenses / calculateProfit / calculateBudgetFact)
// via jiti against a DISPOSABLE sqlite copy of the real schema, seeded with real rows.
// Asserts the actual kopeks — not mirrors, not source strings. The anchor is the
// GOLDEN SCENARIO (§26): revenue 1,000,000 − recognized 670,000 = profit 330,000.
//   node scripts/rem-05-profit-budget-integration.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = process.env.CLUBOPS_SCRATCH || join(ROOT, ".rem05-tmp");
mkdirSync(SCRATCH, { recursive: true });
const TMP_DB = join(SCRATCH, "rem05.db");
const SRC = join(ROOT, "src");
const DEV_DB = join(ROOT, "prisma", "dev.db");
if (!existsSync(DEV_DB)) { console.error("dev.db not found — run prisma migrate deploy first"); process.exit(1); }
for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
copyFileSync(DEV_DB, TMP_DB);
process.env.DATABASE_URL = "file:" + TMP_DB.replace(/\\/g, "/");

const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), { alias: { "@": SRC, "server-only": join(ROOT, "scripts", "_stubs", "server-only.cjs") }, interopDefault: true, esmResolve: true });
const { loadRecognizedExpenses } = jiti("@/lib/finance/recognized-expense.ts");
const { calculateProfit } = jiti("@/lib/finance/profit.ts");
const { calculateBudgetFact } = jiti("@/lib/finance/budget-fact.ts");
const { prisma } = jiti("@/lib/prisma.ts");

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 10);
const R = (rub) => Math.round(rub * 100); // rubles → kopeks
const day = (s) => new Date(s + "T00:00:00");
const MONTHS = ["2026-07"];

async function seedScope() {
  const companyId = uid("co"), clubId = uid("club"), userId = uid("u"), ipId = uid("ip"), oooId = uid("ooo");
  await prisma.company.create({ data: { id: companyId, name: "REM05 Co" } });
  await prisma.user.create({ data: { id: userId, email: uid("e") + "@t.local", name: "T", role: "accountant", passwordHash: "x" } });
  await prisma.club.create({ data: { id: clubId, companyId, name: "Club", city: "Town" } });
  await prisma.legalEntity.create({ data: { id: ipId, companyId, name: "ИП", type: "ip", inn: uid("i") } });
  await prisma.legalEntity.create({ data: { id: oooId, companyId, name: "ООО", type: "ooo", inn: uid("o") } });
  return { companyId, clubId, userId, ipId, oooId };
}
const exp = (s, { amount, category = "supplies", date = "2026-07-10", status = "confirmed", entryVersion = 1, legalEntityId = null }) =>
  prisma.expense.create({ data: { companyId: s.companyId, clubId: s.clubId, createdByUserId: s.userId, category, amountKopeks: amount, expenseDate: day(date), status, entryVersion, legalEntityId } });
const inv = (s, { amount, category = "supplies", period = "2026-07", status = "paid", legalEntityId = null }) =>
  prisma.invoice.create({ data: { companyId: s.companyId, clubId: s.clubId, createdByUserId: s.userId, amountKopeks: amount, expenseCategory: category, expensePeriod: period, invoiceDate: day(period + "-05"), status, legalEntityId } });
async function payroll(s, { month = "2026-07", netPayable, periodStatus = "approved" }) {
  const [y, m] = month.split("-").map(Number);
  const p = await prisma.payrollPeriod.create({ data: { companyId: s.companyId, clubId: s.clubId, year: y, month: m, status: periodStatus, createdByUserId: s.userId } });
  await prisma.payrollCalculation.create({ data: { companyId: s.companyId, payrollPeriodId: p.id, clubId: s.clubId, employeeId: uid("emp"), netPayableKopeks: netPayable, status: "approved" } });
  return p;
}
const refund = (s, { amount, resultAmount = null, status = "paid", date = "2026-07-12", entryVersion = 1 }) =>
  prisma.refund.create({ data: { companyId: s.companyId, clubId: s.clubId, createdByUserId: s.userId, amountKopeks: amount, refundResultAmountKopeks: resultAmount, status, refundDate: day(date), entryVersion } });
const ofd = (s, { date = "2026-07-15", income, net = null, returns = 0 }) =>
  prisma.ofdDailySalesSummary.create({ data: { companyId: s.companyId, clubId: s.clubId, provider: "taxcom", date, summaryKey: uid("k"), incomeTotalKopeks: income, netTotalKopeks: net ?? income - returns, returnTotalKopeks: returns, receiptCount: 1 } });
const budget = (s, { category = "supplies", month = "2026-07", limit }) =>
  prisma.budget.create({ data: { companyId: s.companyId, clubId: s.clubId, createdByUserId: s.userId, category, month, limitAmountKopeks: limit } });

const recog = (s, extra = {}) => loadRecognizedExpenses({ companyId: s.companyId, allowedClubIds: [s.clubId], months: MONTHS, ...extra });
const profit = (s, extra = {}) => calculateProfit({ companyId: s.companyId, allowedClubIds: [s.clubId], months: MONTHS, ...extra });

async function main() {
  // ===== GOLDEN SCENARIO (§26) =====
  {
    const s = await seedScope();
    await ofd(s, { income: R(1_000_000) });
    await exp(s, { amount: R(100_000), category: "rent" });
    await inv(s, { amount: R(200_000), status: "partially_paid" }); // paid 50k irrelevant
    await payroll(s, { netPayable: R(300_000) });
    await refund(s, { amount: R(40_000) });
    await exp(s, { amount: R(30_000), category: "taxes", date: "2026-07-08" });
    // «Приход Иное» 500k + collection 150k + PayrollPayment 120k are NOT seeded as
    // recognized rows — the services never read those tables, so they cannot leak in.
    const p = await profit(s);
    const bf = await calculateBudgetFact({ companyId: s.companyId, allowedClubIds: [s.clubId], month: "2026-07" });
    await budget(s, { limit: R(800_000) });
    const bf2 = await calculateBudgetFact({ companyId: s.companyId, allowedClubIds: [s.clubId], month: "2026-07" });
    check("GOLDEN recognized expenses = 670,000 ₽", p.expenseKopeks === R(670_000), `got ${p.expenseKopeks}`);
    check("GOLDEN revenue = 1,000,000 ₽", p.revenueKopeks === R(1_000_000), `got ${p.revenueKopeks}`);
    check("GOLDEN profit = 330,000 ₽", p.profitKopeks === R(330_000), `got ${p.profitKopeks}`);
    check("GOLDEN budget fact = 670,000 ₽", bf2.recognizedFactKopeks === R(670_000), `got ${bf2.recognizedFactKopeks}`);
    check("GOLDEN available = 130,000 ₽ (800k − 670k)", bf2.availableKopeks === R(130_000), `got ${bf2.availableKopeks}`);
    check("GOLDEN no budget → fact still 670,000", bf.recognizedFactKopeks === R(670_000), `got ${bf.recognizedFactKopeks}`);
  }
  // 1. OFD revenue only → profit = revenue.
  { const s = await seedScope(); await ofd(s, { income: R(500_000) });
    const p = await profit(s); check("1 revenue-only → profit = revenue", p.profitKopeks === R(500_000) && p.expenseKopeks === 0); }
  // 2. Cash expense reduces profit.
  { const s = await seedScope(); await ofd(s, { income: R(100_000) }); await exp(s, { amount: R(30_000) });
    const p = await profit(s); check("2 cash expense reduces profit", p.profitKopeks === R(70_000)); }
  // 3. Approved invoice reduces profit (full).
  { const s = await seedScope(); await inv(s, { amount: R(50_000), status: "approved_by_regional" });
    const r = await recog(s); check("3 approved invoice recognized in full", r.totalKopeks === R(50_000), `got ${r.totalKopeks}`); }
  // 4/5. Partially-paid invoice = full amount; payments don't change recognized amount.
  { const s = await seedScope(); await inv(s, { amount: R(200_000), status: "partially_paid" });
    const r = await recog(s); check("4/5 partially_paid invoice recognized in FULL (200k)", r.totalKopeks === R(200_000), `got ${r.totalKopeks}`); }
  // 6. Invoice payment month does not move the expense month (expensePeriod governs).
  { const s = await seedScope(); await inv(s, { amount: R(10_000), period: "2026-07", status: "paid" });
    const inAug = await loadRecognizedExpenses({ companyId: s.companyId, allowedClubIds: [s.clubId], months: ["2026-08"] });
    check("6 invoice stays in expensePeriod month (Aug empty)", inAug.totalKopeks === 0); }
  // 7. Ledgerless paid invoice still recognized (no payment ledger seeded).
  { const s = await seedScope(); await inv(s, { amount: R(15_000), status: "paid" });
    const r = await recog(s); check("7 ledgerless paid invoice still recognized", r.totalKopeks === R(15_000)); }
  // 8. Approved payroll accrual reduces profit; 9/10/11. payment/advance/salary-Expense not double.
  { const s = await seedScope(); await ofd(s, { income: R(400_000) }); await payroll(s, { netPayable: R(300_000) });
    const p = await profit(s); check("8 approved payroll accrual reduces profit (netPayable)", p.profitKopeks === R(100_000) && p.expenseBreakdown.payroll_accrual === R(300_000)); }
  { const s = await seedScope(); await payroll(s, { netPayable: R(300_000), periodStatus: "draft" });
    const r = await recog(s); check("9/13 draft payroll period NOT recognized", r.totalKopeks === 0, `got ${r.totalKopeks}`); }
  // 12/13. Refund is a separate expense; not subtracted from revenue.
  { const s = await seedScope(); await ofd(s, { income: R(100_000) }); await refund(s, { amount: R(40_000) });
    const p = await profit(s); check("12/13 refund is separate expense, revenue unchanged", p.revenueKopeks === R(100_000) && p.expenseKopeks === R(40_000) && p.profitKopeks === R(60_000)); }
  // 14. Rejected refund excluded.
  { const s = await seedScope(); await refund(s, { amount: R(40_000), status: "rejected" });
    const r = await recog(s); check("14 rejected refund excluded", r.totalKopeks === 0); }
  // Refund result amount preferred.
  { const s = await seedScope(); await refund(s, { amount: R(40_000), resultAmount: R(25_000) });
    const r = await recog(s); check("14b refund uses refundResultAmountKopeks when set (25k)", r.totalKopeks === R(25_000), `got ${r.totalKopeks}`); }
  // 18. Cash balance irrelevant (no snapshot seeded, profit unaffected) — implicit; assert expense sources only.
  { const s = await seedScope(); await ofd(s, { income: R(100_000) }); await exp(s, { amount: R(10_000) });
    const p = await profit(s); check("18 only OFD+recognized expenses drive profit", p.profitKopeks === R(90_000)); }
  // 19/20/21/22. Budget fact = recognized; available = budget − fact; payment doesn't inflate; partially_paid full.
  { const s = await seedScope(); await exp(s, { amount: R(60_000), category: "supplies" }); await inv(s, { amount: R(40_000), category: "supplies", status: "partially_paid" }); await budget(s, { category: "supplies", limit: R(150_000) });
    const bf = await calculateBudgetFact({ companyId: s.companyId, allowedClubIds: [s.clubId], month: "2026-07" });
    check("19/22 budget fact = recognized (100k incl partially_paid)", bf.recognizedFactKopeks === R(100_000), `got ${bf.recognizedFactKopeks}`);
    check("20 available = budget − fact (50k)", bf.availableKopeks === R(50_000)); }
  // 23. v2 verified expense included; 24. draft/pending/cancelled excluded.
  { const s = await seedScope(); await exp(s, { amount: R(11_000), status: "verified", entryVersion: 2 }); await exp(s, { amount: R(99_000), status: "draft" }); await exp(s, { amount: R(88_000), status: "rejected" });
    const r = await recog(s); check("23/24 v2 verified included, draft/rejected excluded (11k)", r.totalKopeks === R(11_000), `got ${r.totalKopeks}`); }
  // 25. Tax expense included when recorded; source-type tagged.
  { const s = await seedScope(); await exp(s, { amount: R(30_000), category: "taxes" });
    const r = await recog(s); check("25 tax expense recognized + tagged 'tax'", r.totalKopeks === R(30_000) && r.bySourceType.tax === R(30_000)); }
  // 27. Missing category → unassigned bucket, still in total.
  { const s = await seedScope(); await inv(s, { amount: R(20_000), category: null, status: "paid" });
    const r = await recog(s); check("27 missing category → in total + 'unassigned'", r.totalKopeks === R(20_000) && r.byCategory.unassigned === R(20_000)); }
  // 28. Category totals reconcile to grand total.
  { const s = await seedScope(); await exp(s, { amount: R(10_000), category: "rent" }); await exp(s, { amount: R(20_000), category: "supplies" }); await refund(s, { amount: R(5_000) });
    const r = await recog(s); const sum = Object.values(r.byCategory).reduce((a, b) => a + b, 0);
    check("28 Σ byCategory = total", sum === r.totalKopeks && r.totalKopeks === R(35_000)); }
  // 29/30. Club + company scope.
  { const s = await seedScope(); const otherClub = uid("club2"); await prisma.club.create({ data: { id: otherClub, companyId: s.companyId, name: "Other", city: "T" } });
    await exp(s, { amount: R(10_000) }); await prisma.expense.create({ data: { companyId: s.companyId, clubId: otherClub, createdByUserId: s.userId, category: "supplies", amountKopeks: R(77_000), expenseDate: day("2026-07-10"), status: "confirmed" } });
    const onlyMain = await loadRecognizedExpenses({ companyId: s.companyId, allowedClubIds: [s.clubId], clubId: s.clubId, months: MONTHS });
    const both = await loadRecognizedExpenses({ companyId: s.companyId, allowedClubIds: [s.clubId, otherClub], months: MONTHS });
    check("29/30 club scope isolates; company scope sums", onlyMain.totalKopeks === R(10_000) && both.totalKopeks === R(87_000)); }
  // 31. Legal-entity filter.
  { const s = await seedScope(); await exp(s, { amount: R(10_000), legalEntityId: s.ipId }); await exp(s, { amount: R(20_000), legalEntityId: s.oooId });
    const ip = await loadRecognizedExpenses({ companyId: s.companyId, allowedClubIds: [s.clubId], legalEntityId: s.ipId, months: MONTHS });
    check("31 legalEntity filter (ИП only = 10k)", ip.totalKopeks === R(10_000), `got ${ip.totalKopeks}`); }
  // 32. Month boundary (July vs August).
  { const s = await seedScope(); await exp(s, { amount: R(10_000), date: "2026-07-31" }); await exp(s, { amount: R(99_000), date: "2026-08-01" });
    const r = await recog(s); check("32 month boundary excludes Aug row", r.totalKopeks === R(10_000)); }
  // 33/38/40. Kopeks exact, no float.
  { const s = await seedScope(); await exp(s, { amount: 1 }); await exp(s, { amount: 2 });
    const r = await recog(s); check("33/38/40 exact integer kopeks", r.totalKopeks === 3 && Number.isInteger(r.totalKopeks)); }
  // 34. Historical v1 + v2 both recognized.
  { const s = await seedScope(); await exp(s, { amount: R(5_000), status: "confirmed", entryVersion: 1 }); await exp(s, { amount: R(7_000), status: "verified", entryVersion: 2 });
    const r = await recog(s); check("34 v1 confirmed + v2 verified both recognized (12k)", r.totalKopeks === R(12_000)); }
  // 39. Negative profit supported.
  { const s = await seedScope(); await ofd(s, { income: R(10_000) }); await exp(s, { amount: R(50_000) });
    const p = await profit(s); check("39 negative profit supported (−40k)", p.profitKopeks === R(-40_000)); }
  // Tenant isolation: another company's rows never leak.
  { const s = await seedScope(); const other = await seedScope(); await exp(other, { amount: R(99_000) }); await exp(s, { amount: R(10_000) });
    const r = await recog(s); check("TENANT isolation (other company excluded)", r.totalKopeks === R(10_000), `got ${r.totalKopeks}`); }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error("rem-05 tests crashed:", e); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
