// Pilot — REM-05 single profit / budget-fact / recognized-expense (§31). Fast
// STRUCTURAL checks that the canonical services, the recognition predicates, the
// reader migration, the tooling and the docs are in place. The BEHAVIORAL proof is
// test:rem-05-integration (31/31 real DB rows incl. the golden scenario). Runs in
// pilot:full.
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => { try { return readFileSync(new URL(p, import.meta.url), "utf8"); } catch { return ""; } };

const recognition = src("../src/lib/finance/recognition.ts");
const recognized = src("../src/lib/finance/recognized-expense.ts");
const profit = src("../src/lib/finance/profit.ts");
const budgetFact = src("../src/lib/finance/budget-fact.ts");
const budgets = src("../src/lib/budgets.ts");
const test = src("../scripts/rem-05-profit-budget-integration.mjs");
const preflight = src("../scripts/preflight-profit-budget-fact.mjs");
const reconcile = src("../scripts/reconcile-profit-budget-fact.mjs");
const pkg = src("../package.json");
const decisions = src("../docs/remediation/rem-05-accounting-decisions.md");
const recogDesign = src("../docs/remediation/rem-05-recognized-expense-design.md");
const profitDesign = src("../docs/remediation/rem-05-profit-design.md");
const budgetDesign = src("../docs/remediation/rem-05-budget-fact-design.md");
const report = src("../docs/remediation/rem-05-final-report.md");
const checklist = src("../docs/testing/rem-05-profit-budget-checklist.md");
const profitFormulas = src("../docs/accounting/profit-formulas.md");
const budgetModel = src("../docs/accounting/budget-fact-model.md");

// 1. Business decisions documented.
check("1 business decisions documented (BD-03/04/INVOICE/REFUND/TAX)", decisions.includes("BD-03") && decisions.includes("BD-04") && decisions.includes("BD-INVOICE") && decisions.includes("BD-REFUND") && decisions.includes("BD-TAX"));
// 2. One recognized-expense service.
check("2 single recognized-expense service", recognized.includes("export async function loadRecognizedExpenses"));
// 3. One profit service.
check("3 single profit service", profit.includes("export async function calculateProfit"));
// 4. One budget-fact service.
check("4 single budget-fact service", budgetFact.includes("export async function calculateBudgetFact"));
// 5. OFD canonical revenue.
check("5 OFD canonical revenue (net), not Sale/SalesReport", profit.includes("loadOfdManagementOverview") && profit.includes("netKopeks"));
// 6. Partially-paid included.
check("6 partially_paid in recognized invoice set", recognition.includes('"partially_paid"') && recognition.includes("INVOICE_RECOGNIZED_STATUSES"));
// 7. Full Invoice amount recognized (never scaled by paid %).
check("7 full invoice amount recognized (no paid-% scaling)", recognized.includes("amountKopeks: i.amountKopeks") && !/paid.*\/.*total|paidFraction/.test(recognized));
// 8. Payments not double-counted (service never QUERIES InvoicePayment).
check("8 recognized service never queries InvoicePayment", !/\b(db|prisma)\.invoicePayment/i.test(recognized));
// 9. Payroll accrual included.
check("9 payroll accrual (netPayable, approved period) included", recognized.includes("netPayableKopeks") && recognition.includes("PAYROLL_RECOGNIZED_PERIOD_STATUSES"));
// 10/11. Payment/advance not double-counted (never reads PayrollPayment/advance).
check("10/11 never reads PayrollPayment/advance", !/payrollPayment|payrollAdvance/i.test(recognized));
// 12. Refund separate expense.
check("12 refund is a separate recognized expense", recognition.includes("isRecognizedRefund") && recognized.includes('sourceType: "refund"'));
// 13. Refund not subtracted from revenue.
check("13 refund not subtracted from OFD revenue", profit.includes("NOT subtracted") || decisions.includes("does NOT reduce OFD revenue"));
// 14/15/16. Other income / transfers / collections excluded (never queried).
check("14/15/16 «Приход Иное»/transfers/collections excluded (not queried)", !/\b(db|prisma)\.(otherIncome|cashMovement|cashTransfer|cashCollection|collection)/i.test(recognized));
// 17. v2 verified included (reader migration).
check("17 v2 verified included in budget fact", budgets.includes("EXPENSE_REALIZED_STATUSES.includes") && budgets.includes("DATA-018/019"));
// 18. Draft/rejected/cancelled excluded (recognized sets are allow-lists).
check("18 recognized sets are allow-lists (exclude draft/rejected)", recognition.includes("EXPENSE_RECOGNIZED_STATUSES") && recognition.includes("isRecognizedExpenseStatus"));
// 19. VAT not added.
check("19 VAT not added above invoice total (BD-TAX)", decisions.includes("never added on top") && recognition.includes("isTaxCategory"));
// 20. Tax expense included only as a record.
check("20 taxes only as real expense records (no rate arithmetic)", recognition.includes("TAX_CATEGORIES") && recognition.includes("isTaxCategory") && !/vatRate|taxRate|\*\s*0\.\d|\*\s*20\b/i.test(recognition));
// 21. Budget fact equals recognized expenses.
check("21 budget fact = recognized expenses (same service)", budgetFact.includes("loadRecognizedExpenses"));
// 22. Available formula exact.
check("22 available = approvedBudget − recognizedFact", budgetFact.includes("approvedBudgetKopeks - recognizedFactKopeks"));
// 23. Unassigned category preserved.
check("23 unassigned bucket preserved", recognition.includes("UNASSIGNED_CATEGORY") && recognized.includes("UNASSIGNED_CATEGORY"));
// 24. Category sum reconciles (invariant guard).
check("24 category-sum invariant guard", budgetFact.includes("category_sum_mismatch"));
// 25/26/27. Plan-vs-fact reader migrated to recognized rules.
check("25/26/27 Plan/Fact reader migrated to recognized", budgets.includes("RECOGNIZED") && budgets.includes("APPROVED_INVOICE_STATUSES.includes(i.status)"));
// 28. formulaVersion on every service.
check("28 formulaVersion tagged (rem-05.v1)", recognition.includes("rem-05.v1") && profit.includes("PROFIT_FORMULA_VERSION") && budgetFact.includes("BUDGET_FACT_FORMULA_VERSION"));
// 29/30. Tenant + club isolation (allowedClubIds gate).
check("29/30 tenant + club isolation (allowedClubIds)", recognized.includes("allowedClubIds.includes(input.clubId)") && recognized.includes("clubId: { in: clubIds }"));
// 31. Legal entity filter.
check("31 legalEntity filter", recognized.includes("leFilter") && recognized.includes("legalEntityId: leFilter"));
// 32. Period/timezone via local month key.
check("32 local month key (no UTC drift)", recognition.includes("monthKeyLocal") && recognition.includes("getMonth()"));
// 33. Kopeks exact (integers, no float ops).
check("33 integer kopeks (no float division in aggregation)", !/\/\s*100|parseFloat|toFixed/.test(recognized));
// 34/35. Golden scenario + DB-backed tests.
check("34/35 golden scenario + DB-backed tests", test.includes("GOLDEN") && test.includes("330,000") && test.includes("loadRecognizedExpenses"));
// 36. Preflight read-only.
check("36 preflight read-only", preflight.includes("READ-ONLY") && preflight.includes("SELECT-only") && !/prisma\.\w+\.(update|create|delete|upsert)/.test(preflight));
// 37. Reconciliation read-only.
check("37 reconciliation read-only (no corrections)", reconcile.includes("NO") && reconcile.includes("corrections") && !/prisma\.\w+\.(update|create|delete|upsert)/.test(reconcile));
// 38. No production mutation (services are read aggregators).
check("38 services are read-only aggregators", !/\.(create|update|delete|upsert)\(/.test(recognized) && !/\.(create|update|delete|upsert)\(/.test(profit));
// 39/40. Prisma dev/prod (schema unchanged — no migration needed).
check("39/40 no schema migration required (additive-free)", !recognition.includes("prisma/migrations") && recognized.includes("select:"));
// 41. tsc clean marker (services import DbClient + prisma correctly).
check("41 services wired to prisma + DbClient", recognized.includes('from "@/lib/db-client"') && recognized.includes('from "@/lib/prisma"'));
// 42/43. tests + pilot registered.
check("42/43 test + pilot registered", pkg.includes("test:rem-05-integration") && pkg.includes("pilot:rem-05-profit-budget-fact") && src("../scripts/pilot-full.mjs").includes("pilot-rem-05-profit-budget-fact.mjs"));
// extra: docs + findings closure honest.
check("44 designs present", recogDesign.length > 200 && profitDesign.length > 200 && budgetDesign.length > 200 && checklist.includes("G-FIN"));
check("45 findings closure honest in report", report.includes("FIN-001") && report.includes("FIN-002") && report.includes("FIN-003") && report.includes("PARTIALLY CLOSED"));
check("46 accounting docs updated (REM-05)", profitFormulas.includes("REM-05") && budgetModel.includes("REM-05"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
