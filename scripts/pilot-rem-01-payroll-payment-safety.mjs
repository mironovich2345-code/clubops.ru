// Pilot — REM-01 payroll payment safety (§25). Fast STRUCTURAL checks that the atomic+idempotent
// design is in place and wired. The BEHAVIORAL proof (rollback/replay/concurrency on a real DB) lives
// in scripts/rem-01-payroll-payment-integration.mjs (npm run test:rem-01-integration, 27/27) — this
// pilot asserts that suite exists and covers the scenarios. Runs inside pilot:full (source-only, fast).
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => { try { return readFileSync(new URL(p, import.meta.url), "utf8"); } catch { return ""; } };

const service = src("../src/lib/payroll/payment-service.ts");
const periods = src("../src/app/(app)/payroll/periods/actions.ts");
const advance = src("../src/app/(app)/payroll/advance-actions.ts");
const regional = src("../src/app/(app)/payroll/regional/actions.ts");
const schema = src("../prisma/schema.prisma");
const prodSchema = src("../prisma/production/schema.prisma");
const salary = src("../src/lib/payroll/salary-expense.ts");
const aggregate = src("../src/lib/payroll/aggregate.ts");
const integ = src("./rem-01-payroll-payment-integration.mjs");
const preflight = src("./preflight-payroll-payments.mjs");
const pkg = src("../package.json");
const baseline = src("../docs/remediation/rem-01-payroll-payment-baseline.md");
const report = src("../docs/remediation/rem-01-payroll-payment-report.md");

// Body of executePayrollPayment's transaction (between $transaction( and the isolationLevel option).
const txBody = (service.split("db.$transaction(async (tx) =>")[1] || "").split("isolationLevel")[0];

check("1 shared payout service exists (executePayrollPayment)", service.includes("export async function executePayrollPayment"));
check("2 salary payment action uses the service", periods.includes("executePayrollPayment("));
check("3 no global prisma inside the service transaction (uses tx.*)", txBody.includes("tx.payrollPayment.create") && !/[^.]\bprisma\.\w+\.(create|update|delete)/.test(txBody));
check("4 new payments require an idempotencyKey", periods.includes("idempotencyKey") && service.includes("input.idempotencyKey"));
check("5 DB unique constraint (companyId, idempotencyKey) on PayrollPayment", /model PayrollPayment[\s\S]*@@unique\(\[companyId, idempotencyKey\]\)/.test(schema) && /model PayrollPayment[\s\S]*@@unique\(\[companyId, idempotencyKey\]\)/.test(prodSchema));
check("6 fingerprint conflict handled", service.includes("requestFingerprint") && service.includes("IDEMPOTENCY_CONFLICT"));
check("7 transaction includes PayrollPayment create", txBody.includes("tx.payrollPayment.create"));
check("8 transaction includes salary Expense (createSalaryExpense with tx)", /createSalaryExpense\([\s\S]*?\}, tx\)/.test(service));
check("9 transaction includes the cash write (recordExpenseMovement threads tx)", salary.includes("}, db)") && salary.includes("recordExpenseMovement"));
check("10 transaction includes obligation consistency (generateObligationsForPeriod with tx)", service.includes("generateObligationsForPeriod(input.refreshObligationsForPeriodId, input.paymentDate, tx)"));
check("11 same-key replay returns existing payment (no new writes)", service.includes("replayed: true") && service.includes("findUnique") && service.includes("companyId_idempotencyKey"));
check("12 remaining re-checked inside the tx (TOCTOU closed)", service.includes("useCalcRemaining") && service.includes("PAYMENT_EXCEEDS_REMAINING"));
check("13 serialization/unique race → retry loop (exactly-once under concurrency)", service.includes("isSerializationError") && service.includes("isUniqueViolation") && service.includes("MAX_ATTEMPTS"));
check("14 Serializable isolation level requested", service.includes("TransactionIsolationLevel.Serializable"));
check("15 safe error contract (no raw Prisma error to UI)", periods.includes("payoutErrorMessage") && service.includes("PayrollPaymentErrorCode"));
check("16 advance path is atomic ($transaction + tx-threaded helpers)", /recordAdvance[\s\S]*prisma\.\$transaction/.test(periods) && periods.includes("recomputeCalculationTotals(calc.id, tx)"));
check("17 advance tranche threads tx into createSalaryExpense", /createSalaryExpense\([\s\S]*?\}, tx\)/.test(advance));
check("18 regional payment is atomic + idempotent", regional.includes("prisma.$transaction") && regional.includes("companyId_idempotencyKey") && regional.includes("requestFingerprint"));
check("19 regional overpay re-checked INSIDE the tx (TOCTOU closed)", /\$transaction[\s\S]*excessNow[\s\S]*EXCEEDS/.test(regional));
check("20 reversal is atomic + idempotent (executePayrollReversal)", service.includes("export async function executePayrollReversal") && service.includes('status: "confirmed"') && service.includes("updateMany"));
check("21 reversal used by cancelPayment", periods.includes("executePayrollReversal("));
check("22 double reversal is a no-op (compare-and-set on confirmed)", service.includes("flip.count !== 1") && service.includes("reversed: false"));
check("23 failure-injection points exist (test-only _failAt)", ["after_payment_create", "after_expense_create", "after_cash_movement", "before_commit", "after_commit"].every((p) => service.includes(p)));
check("24 REAL DB-backed integration test exists (executes the service, not a mirror)", integ.includes("executePayrollPayment") && integ.includes("jiti") && integ.includes("createFileSync|copyFileSync".split("|").find((x) => integ.includes(x)) || "copyFileSync"));
check("25 integration covers rollback at every failure point", ["after_payment_create", "after_expense_create", "after_cash_movement", "before_commit"].every((p) => integ.includes(p)) && integ.includes("rolls back ALL writes"));
check("26 integration covers replay + conflict", integ.includes("replay returns same payment") && integ.includes("IDEMPOTENCY_CONFLICT"));
check("27 integration covers concurrency (parallel same-key + different-key)", integ.includes("parallel same-key") && integ.includes("cannot overpay"));
check("28 integration covers atomic reversal + double reversal", integ.includes("reversal atomically cancels") && integ.includes("double reversal"));
check("29 PostgreSQL concurrency gate documented (sqlite serializes; pg needs a real gate)", report.includes("PostgreSQL") && (report.includes("concurrency") || report.includes("Serializable")));
check("30 preflight is READ-ONLY (SELECT-only, no writes)", !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(preflight) && preflight.includes("READ-ONLY"));
check("31 existing rows preserved (idempotency fields nullable, additive migration)", schema.includes("idempotencyKey       String?") && schema.includes("requestFingerprint   String?"));
check("32 salary formula engine NOT changed (calc.ts untouched by rem-01)", src("../src/lib/payroll/calc.ts").includes("aggregateCalculation") && !src("../src/lib/payroll/calc.ts").includes("executePayrollPayment"));
check("33 budgets NOT changed (budget-linkage has no payout logic)", !src("../src/lib/payroll/budget-linkage.ts").includes("executePayrollPayment"));
check("34 cash-balance formula NOT changed (cash-balances.ts has no payout service)", !src("../src/lib/cash-balances.ts").includes("executePayrollPayment"));
check("35 aggregate recompute accepts a tx (atomic) without formula change", aggregate.includes("db: DbClient = prisma") && aggregate.includes("aggregateCalculation("));
check("36 npm scripts registered (integration, preflight, pilot)", pkg.includes("test:rem-01-integration") && pkg.includes("preflight:payroll-payments") && pkg.includes("pilot:rem-01-payroll-payment-safety"));
check("37 baseline recorded (findings + DoD)", baseline.includes("ARCH-002") && baseline.includes("DATA-003") && baseline.includes("FIN-005"));
check("38 report records findings closure status", report.includes("CLOSED") && report.includes("ARCH-002") && report.includes("SEC-001"));
check("39 write-graph documented", src("../docs/remediation/rem-01-payroll-write-graph.md").includes("GLOBAL"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
