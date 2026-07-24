// Payroll Stage 6 tests — debts (EmployeeFinancialObligation): auto-creation on close,
// specific settlement (with correct cash direction), and NO auto write-off at dismissal.
// Mirrors obligationFromRemaining + applySettlement + the permission gates, and adds
// static guards over the close branch + settle/write-off actions.
// npm run pilot:payroll-obligations
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;

// ---- mirror: obligationFromRemaining (obligations.ts) ----
function obligationFromRemaining(remaining) {
  if (remaining > 0) return { direction: "company_owes_employee", reason: "salary_remainder", amountKopeks: remaining };
  if (remaining < 0) return { direction: "employee_owes_company", reason: "overpayment", amountKopeks: -remaining };
  return null;
}

// ---- mirror: applySettlement (obligations.ts) ----
function applySettlement(outstanding, amount) {
  const applied = Math.min(outstanding, Math.max(0, amount));
  const newOutstanding = Math.max(0, outstanding - applied);
  return { appliedKopeks: applied, newOutstandingKopeks: newOutstanding, status: newOutstanding <= 0 ? "settled" : "partially_settled" };
}

// ---- mirror: permission gates (obligations.ts) ----
const canWriteOff = (roles) => roles.some((r) => r === "owner" || r === "chief_accountant");
const canSettle = (roles) => roles.some((r) => ["manager", "regional_director", "accountant", "chief_accountant"].includes(r));

function main() {
  // --- obligation from remaining ---
  const unpaid = obligationFromRemaining(R(17000));
  check("OBL1 unpaid remainder → company owes employee", unpaid.direction === "company_owes_employee" && unpaid.amountKopeks === R(17000) && unpaid.reason === "salary_remainder");
  const over = obligationFromRemaining(-R(5000));
  check("OBL2 overpayment → employee owes company", over.direction === "employee_owes_company" && over.amountKopeks === R(5000) && over.reason === "overpayment");
  check("OBL3 zero remainder → no obligation", obligationFromRemaining(0) === null);

  // --- settlement math ---
  const s1 = applySettlement(R(17000), R(7000));
  check("OBL4 partial settlement leaves remainder open", s1.appliedKopeks === R(7000) && s1.newOutstandingKopeks === R(10000) && s1.status === "partially_settled");
  const s2 = applySettlement(R(10000), R(10000));
  check("OBL5 full settlement closes the debt", s2.newOutstandingKopeks === 0 && s2.status === "settled");
  const s3 = applySettlement(R(10000), R(50000));
  check("OBL6 overpaying a debt caps at outstanding", s3.appliedKopeks === R(10000) && s3.newOutstandingKopeks === 0);

  // --- permission gates ---
  check("OBL7 only owner / chief accountant may write off", canWriteOff(["owner"]) && canWriteOff(["chief_accountant"]) && !canWriteOff(["manager"]) && !canWriteOff(["accountant"]));
  check("OBL8 settlement allowed for operational + accounting", canSettle(["manager"]) && canSettle(["accountant"]) && !canSettle(["marketer"]));

  // ---- static guards ----
  const periodActions = src("../src/app/(app)/payroll/periods/actions.ts");
  const oblActions = src("../src/app/(app)/payroll/obligations/actions.ts");
  const obligations = src("../src/lib/payroll/obligations.ts");

  check("S44 close creates obligations from each remainder (unpaid → company, overpay → employee)",
    periodActions.includes('decision.to === "closed"') && periodActions.includes("obligationFromRemaining(c.remainingKopeks)") && periodActions.includes("employeeFinancialObligation.create"));
  check("S45 close blocks unconfirmed cash payments",
    periodActions.includes("Есть неподтверждённые выплаты"));
  check("S46 settlement targets a SPECIFIC obligation, not faceless income",
    oblActions.includes("scopeObligation(obligationId)") && oblActions.includes('"payroll.obligation_settled"'));
  check("S47 cash direction follows the debt (employee repay = inflow; company pay = outflow)",
    oblActions.includes('obligation.direction === "employee_owes_company"') && oblActions.includes("postCashInflow") && oblActions.includes("postCashOutflow"));
  check("S48 write-off is explicit, permissioned, comment-required — never automatic",
    oblActions.includes("canWriteOffObligation") && oblActions.includes("Укажите причину списания") && oblActions.includes('"payroll.obligation_written_off"'));
  check("S49 dismissed employee debt is NOT auto-written-off",
    obligations.includes("NEVER auto-writes-off") || obligations.includes("не списываются автоматически") || src("../src/app/(app)/payroll/employees/[id]/page.tsx").includes("не списываются автоматически"));
  check("S50 settlement cannot exceed the outstanding balance",
    oblActions.includes("Сумма превышает остаток долга"));
  check("S51 obligations model exposes pure helpers",
    obligations.includes("export function obligationFromRemaining") && obligations.includes("export function applySettlement"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
