// READ-ONLY generator for the FULL AUDIT 3/6 machine-readable accounting artifacts. NO DB, NO
// writes to source. Emits the distilled audit knowledge as JSON so downstream tooling / reviewers
// can diff it: financial-number-map.json, formula-matrix.json, business-decisions.json.
//   node scripts/audit-formula-map.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const out = join(ROOT, "docs/audits/data");
mkdirSync(out, { recursive: true });

// Each financial number → canonical source + competing sources (>1 = divergence).
const financialNumberMap = {
  generatedBy: "audit-formula-map",
  numbers: [
    { number: "OFD revenue", canonical: "OfdDailySalesSummary.net (income−return)", competing: [], sources: 1 },
    { number: "cash ООО", canonical: "calculateCashBalances.cashOooFactBalance (cash-balances.ts:158)", competing: ["BalanceSnapshot.actualBalanceKopeks (getLatestBalancesByClub.oooKopeks)", "analytics.ExecutiveSummary.cashOooRemainingKopeks (analytics.ts:536, SalesReport cash_ooo−encashment)"], sources: 3 },
    { number: "cash ИП", canonical: "calculateCashBalances.cashIpFactBalance (cash-balances.ts:143)", competing: ["walletBalanceKopeks(club_cash) legacy contour A (cash-wallets.ts:59)"], sources: 2 },
    { number: "«Приход Иное»", canonical: "CashOtherIncome (contour B)", competing: ["CashMovement.other_cash_income (contour A)"], sources: 2, note: "not in profit" },
    { number: "invoice paid", canonical: "Σ confirmed InvoicePayment (invoice-payments.ts:15)", competing: ["Invoice.status/paidAt cache; legacy pay action = ledgerless (DATA-005)"], sources: 1 },
    { number: "profit", canonical: "analytics.ts:557 (Sale+SalesReport revenue − spend)", competing: ["analytics/page.tsx:433 OFD path (ofd net − expenses)", "dashboard.ts:23 (DEAD CODE, no importer)"], sources: 2 },
    { number: "budget fact", canonical: "computeBudgetFactReport (paid-only, confirmed-only) budgets.ts:280", competing: ["computeUsedKopeks (approved+paid, confirmed+verified) budgets.ts:76", "computeBudgetOverruns (confirmed-only) budgets.ts:162"], sources: 3 },
    { number: "payroll accrual", canonical: "PayrollCalculation.grossAccruedKopeks (net==gross, no withholding)", competing: [], sources: 1 },
    { number: "payroll paid", canonical: "PayrollCalculation.paidKopeks (Σ confirmed payments + active tranches)", competing: ["recompute-gated cache; ledger is truth"], sources: 1 },
    { number: "payroll remaining", canonical: "PayrollCalculation.remainingKopeks", competing: ["PayrollPaymentObligation.remainingKopeks (2nd cache, lags — DATA-016)"], sources: 2 },
    { number: "debt", canonical: "EmployeeFinancialObligation.outstandingAmountKopeks", competing: ["PayrollCalculation.employeeDebtKopeks/companyDebtKopeks", "analytics network debt (approved-unpaid invoices+refunds)"], sources: 3 },
    { number: "refund amount", canonical: "Refund.amountKopeks (= refundResultAmountKopeks for v2)", competing: [], sources: 1, note: "single-effect: expense category 'refunds', not a revenue reduction" },
  ],
};

// Formula matrix: recognition + the readers, with the mismatch flags.
const formulaMatrix = {
  generatedBy: "audit-formula-map",
  recognition: [
    { tx: "cash Expense (v2)", event: "verify (status→verified)", date: "expenseDate", cash: "ИП wallet + fact (double-write)", budget: "confirmed+verified (used) / confirmed-only (fact-report)", profit: "included (confirmed+verified)", accrual: "expenseDate" },
    { tx: "Invoice (unpaid)", event: "NOT a P&L expense until status=paid", date: "expensePeriod", cash: "none", budget: "approved-unpaid=committed (used) / not in fact-report", profit: "excluded until paid", accrual: "expensePeriod" },
    { tx: "Invoice paid", event: "status=paid", date: "expensePeriod (accrual)", cash: "InvoicePayment ledger", budget: "fact (paid) by expensePeriod", profit: "included by expensePeriod", accrual: "expensePeriod" },
    { tx: "Invoice partially_paid", event: "derivedInvoiceStatus", date: "expensePeriod", cash: "InvoicePayment", budget: "in NEITHER used nor fact-report", profit: "EXCLUDED (analytics counts status=paid only)", accrual: "expensePeriod", mismatch: "partially_paid vanishes from profit+budget, present in calendar (FIN)" },
    { tx: "PayrollCalculation (accrual)", event: "approve period", date: "period year/month", cash: "none (liability)", budget: "payroll budget module only", profit: "NOT counted (payroll absent from profit)", accrual: "period" },
    { tx: "PayrollPayment", event: "record (creates salary Expense)", date: "paymentDate (now)", cash: "Expense + CashMovement (double-write)", budget: "as an Expense", profit: "as the salary Expense", accrual: "expenseDate of the salary Expense" },
    { tx: "Refund (v2)", event: "status=paid", date: "paidAt", cash: "chosen legalEntity", budget: "category 'refunds' (single-effect)", profit: "added to SPEND, not a revenue reduction; no Expense row", accrual: "paidAt" },
    { tx: "tax", event: "as an Expense category 'taxes'", date: "expenseDate", cash: "as expense", budget: "category 'taxes'", profit: "as expense", accrual: "no dedicated tax model (BUSINESS DECISION)" },
  ],
  profitReaders: [
    { reader: "analytics.ts:557", revenue: "Sale(confirmed)+SalesReport total_revenue(confirmed)", spend: "Expense(confirmed+verified)+paid Invoice(by expensePeriod)+paid Refund", payroll: "only via salary Expense", partiallyPaid: "excluded" },
    { reader: "analytics/page.tsx:433 (OFD path, useOfd)", revenue: "OFD net (income−returns)", spend: "same confirmed expenses", payroll: "same", note: "different revenue basis than analytics.ts:557 on the same card" },
    { reader: "dashboard.ts:23", revenue: "SaleSummary", spend: "ExpenseSummary", status: "DEAD CODE (no importer)" },
  ],
  budgetFactReaders: [
    { fn: "computeUsedKopeks (budgets.ts:76)", expense: "confirmed+verified", invoice: "approved-unpaid + paid", refund: "approved-unpaid+paid", refundDate: "refundDate??createdAt" },
    { fn: "computeBudgetOverruns (budgets.ts:162)", expense: "confirmed ONLY", invoice: "approved-unpaid+paid", refund: "approved-unpaid+paid", refundDate: "refundDate??createdAt" },
    { fn: "computeBudgetFactReport (budgets.ts:280)", expense: "confirmed ONLY (drops v2 verified — DATA-019)", invoice: "paid ONLY", refund: "paid ONLY", refundDate: "paidAt??refundDate??createdAt" },
  ],
  roundingEngines: [
    { engine: "payroll engine 1 (calc.ts:17 applyBp)", rule: "ceilToRubleKopeks(Math.round(k*bp/BP)) — double round + ceil-to-ruble" },
    { engine: "payroll engine 2 (formulas.ts:34 pct)", rule: "Math.round(k*bp/BP) — kopeck round, no ruble ceil; component-wise summed" },
    { note: "same % of money differs by up to ~1₽/component between engines; both live (calc.ts non-role, formulas.ts role_*)" },
    { engine: "refunds (refund-membership/personal-training)", rule: "BigInt ceilToRubleKopeks on the total; per-unit never pre-rounded; numerator===0n and negative guards" },
  ],
};

// Questions code cannot settle — require a confirmed accountant/owner decision.
const businessDecisions = {
  generatedBy: "audit-formula-map",
  decisions: [
    { id: "BD-01", q: "Expense recognition for invoices: by accrual (expensePeriod) or by payment date?", current: "by expensePeriod (accrual)", impact: "which month an invoice hits P&L/budget/profit" },
    { id: "BD-02", q: "Is a client refund a revenue reduction or a separate expense?", current: "separate expense (category 'refunds'), NOT a revenue reduction", impact: "profit & budget attribution; VAT/tax base" },
    { id: "BD-03", q: "What exactly is 'profit'? (Sale+SalesReport basis vs OFD basis; payroll included?)", current: "two definitions; payroll NOT included in any profit reader", impact: "owner P&L trust" },
    { id: "BD-04", q: "What is 'budget fact'? approval-committed or paid-realized; include v2 verified expenses?", current: "3 definitions; fact-report is paid-only+confirmed-only, drops v2 verified", impact: "overrun alerts & plan-fact" },
    { id: "BD-05", q: "Does ФОТ (salary budget) include taxes/contributions?", current: "salaryBudgetIncludesTaxes flag, default OFF; no tax model", impact: "salary budget sizing" },
    { id: "BD-06", q: "Who is the payer for shared payroll / a shared employee across clubs?", current: "no allocation rule; company-level fallback", impact: "club P&L attribution" },
    { id: "BD-07", q: "How is a regional director's cost allocated across clubs?", current: "regional payment expense filed to source club; employeeId may hold a payroll-row id (DATA-010)", impact: "club cost accuracy" },
    { id: "BD-08", q: "How is regional-held cash accounted (передача регионалу / возврат)?", current: "CashRegionalTransfer reduces ИП only when confirmed; return is out-of-band «Иное»", impact: "ИП cash truth" },
    { id: "BD-09", q: "Which cash contour is the OFFICIAL one? (A wallet vs B fact)", current: "B is canonical in readers; A still written, never reconciled", impact: "single cash source of truth" },
    { id: "BD-10", q: "How are internal transfers (ООО→ИП, opening balance) reflected — never income, correct?", current: "correct: not in profit; but written to both contours", impact: "no double income (confirmed OK)" },
    { id: "BD-11", q: "May a refund be paid from an ИП different from the original sale's legal entity?", current: "legalEntity chosen at payment, validated to the club, not to the original sale", impact: "cross-entity refund legality" },
    { id: "BD-12", q: "What is the 'fact date' of an expense — accrual, approval, or payment?", current: "mixed: expense by expenseDate, invoice by expensePeriod, refund by paidAt", impact: "period reporting consistency" },
    { id: "BD-13", q: "Is VAT/НДС tracked separately, and is there a УСН/tax-liability model?", current: "NO tax model — VAT folded into invoice total; 'taxes' is just an expense category", impact: "tax reporting; BUSINESS DECISION REQUIRED" },
    { id: "BD-14", q: "Should manual Sale/SalesReport revenue and OFD revenue ever coexist (double-count risk)?", current: "manual sales disabled; Sale+SalesReport still feed analytics revenue — verify no overlap with OFD", impact: "revenue double-count" },
  ],
};

writeFileSync(join(out, "financial-number-map.json"), JSON.stringify(financialNumberMap, null, 2));
writeFileSync(join(out, "formula-matrix.json"), JSON.stringify(formulaMatrix, null, 2));
writeFileSync(join(out, "business-decisions.json"), JSON.stringify(businessDecisions, null, 2));
const multi = financialNumberMap.numbers.filter((n) => n.sources > 1).length;
console.log("=== Accounting formula map (read-only, curated from Audit 3 evidence) ===");
console.log(`financial numbers: ${financialNumberMap.numbers.length} (with >1 source: ${multi})`);
console.log(`recognition rows: ${formulaMatrix.recognition.length} | profit readers: ${formulaMatrix.profitReaders.length} | budget-fact readers: ${formulaMatrix.budgetFactReaders.length}`);
console.log(`business decisions required: ${businessDecisions.decisions.length}`);
console.log("Wrote financial-number-map.json, formula-matrix.json, business-decisions.json");
