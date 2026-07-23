// Payroll Stage 4 tests — workflow transitions, adjustment direction/aggregation, and
// the lock-after-approval + comment-required + closed-immutable guards.
// Mirrors period.ts (status machine), the adjustment-direction rule, and
// aggregateCalculation; plus static guards over the actions + access wiring.
// npm run pilot:payroll-workflow
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;

// ---- mirror: status machine (period.ts) ----
const REG = ["regional_director"], ACC = ["accountant", "chief_accountant"];
const RULES = {
  submit: { from: ["draft", "needs_correction"], to: "manager_submitted", roles: ["manager"] },
  start_regional_review: { from: ["manager_submitted"], to: "regional_review", roles: REG },
  return_for_correction: { from: ["manager_submitted", "regional_review", "accounting_review"], to: "needs_correction", roles: [...REG, ...ACC] },
  regional_approve: { from: ["manager_submitted", "regional_review"], to: "regional_approved", roles: REG },
  start_accounting_review: { from: ["regional_approved"], to: "accounting_review", roles: ACC },
  accounting_approve: { from: ["regional_approved", "accounting_review"], to: "approved", roles: ACC },
  mark_partially_paid: { from: ["approved", "partially_paid"], to: "partially_paid", roles: ["manager", ...REG, ...ACC] },
  mark_paid: { from: ["approved", "partially_paid"], to: "paid", roles: ["manager", ...REG, ...ACC] },
  close: { from: ["paid", "partially_paid"], to: "closed", roles: [...REG, ...ACC] },
};
const apply = (a, status, roles) => { const r = RULES[a]; if (!r) return { ok: false }; if (!r.from.includes(status)) return { ok: false }; if (!roles.some((x) => r.roles.includes(x))) return { ok: false }; return { ok: true, to: r.to }; };
const locked = (s) => ["approved", "partially_paid", "paid", "closed"].includes(s);
const closed = (s) => s === "closed";

// ---- mirror: adjustment direction (actions.ts) ----
function adjustmentDirection(type, raw) {
  switch (type) {
    case "bonus": return "credit";
    case "penalty": case "overpayment_recovery": case "shortage_recovery": case "trainer_credit_recovery": return "debit";
    case "correction": case "other": return raw === "credit" || raw === "debit" ? raw : null;
    default: return null;
  }
}

// ---- mirror: aggregateCalculation (calc.ts) ----
const aggregate = ({ automatic, credits = 0, debits = 0, advance = 0, other = 0 }) => {
  const gross = automatic + credits - debits, net = gross, paid = advance + other, remaining = net - paid;
  return { gross, net, paid, remaining, employeeDebt: remaining < 0 ? -remaining : 0, companyDebt: remaining > 0 ? remaining : 0 };
};

// ---- mirror: canAddPayrollAdjustment (access.ts) ----
function canAdjust(roles, lockedFlag) {
  const acc = roles.some((r) => r === "accountant" || r === "chief_accountant");
  if (lockedFlag) return acc;
  return acc || roles.some((r) => r === "manager" || r === "regional_director");
}

function main() {
  // --- full happy-path chain ---
  check("WF1 submit → manager_submitted", apply("submit", "draft", ["manager"]).to === "manager_submitted");
  check("WF2 regional approves", apply("regional_approve", "manager_submitted", REG).to === "regional_approved");
  check("WF3 accounting approves", apply("accounting_approve", "regional_approved", ACC).to === "approved");
  check("WF4 return for correction from any review stage", apply("return_for_correction", "regional_review", REG).to === "needs_correction" && apply("return_for_correction", "accounting_review", ACC).to === "needs_correction");
  check("WF5 resubmit after correction", apply("submit", "needs_correction", ["manager"]).to === "manager_submitted");
  check("WF6 manager cannot approve", apply("regional_approve", "manager_submitted", ["manager"]).ok === false);
  check("WF7 no skipping straight to approved", apply("accounting_approve", "manager_submitted", ACC).ok === false);
  check("WF8 close only from paid/partially_paid", apply("close", "paid", ACC).ok === true && apply("close", "approved", ACC).ok === false);

  // --- lock semantics ---
  check("WF9 approved period is locked", locked("approved") === true && locked("regional_review") === false);
  check("WF10 closed is immutable", closed("closed") === true && closed("paid") === false);

  // --- adjustment direction mapping ---
  check("WF11 bonus is a credit (+)", adjustmentDirection("bonus", "") === "credit");
  check("WF12 penalty is a debit (−)", adjustmentDirection("penalty", "") === "debit");
  check("WF13 recoveries are debits", ["overpayment_recovery", "shortage_recovery", "trainer_credit_recovery"].every((t) => adjustmentDirection(t, "") === "debit"));
  check("WF14 correction takes direction from form", adjustmentDirection("correction", "debit") === "debit" && adjustmentDirection("correction", "") === null);

  // --- aggregation with adjustments ---
  const a1 = aggregate({ automatic: R(40000), credits: R(5000), debits: R(2000) });
  check("WF15 gross = automatic + bonus − penalty", a1.gross === R(43000) && a1.net === R(43000));
  const a2 = aggregate({ automatic: R(30000), credits: 0, debits: 0, advance: R(35000) });
  check("WF16 overpay → employee debt", a2.employeeDebt === R(5000) && a2.companyDebt === 0);
  const a3 = aggregate({ automatic: R(47000), advance: R(20000), other: R(10000) });
  check("WF17 partial pay → company debt (remainder)", a3.remaining === R(17000) && a3.companyDebt === R(17000));

  // --- permission gate ---
  check("WF18 before approval manager may adjust", canAdjust(["manager"], false) === true);
  check("WF19 after approval only accounting may adjust", canAdjust(["manager"], true) === false && canAdjust(["accountant"], true) === true);

  // ---- static guards ----
  const actions = src("../src/app/(app)/payroll/periods/actions.ts");
  const access = src("../src/lib/payroll/access.ts");
  const aggregateSrc = src("../src/lib/payroll/aggregate.ts");

  check("S25 comment is required for an adjustment", actions.includes("Комментарий обязателен"));
  check("S26 closed period rejects adjustments", actions.includes("isPayrollPeriodClosed(scope.period.status)") && actions.includes("Период закрыт — изменения невозможны"));
  check("S27 approval blocked while any calc is a draft", actions.includes('status: "draft"') && actions.includes("есть нерассчитанные позиции"));
  check("S28 approval locks the calculations", actions.includes('status: "calculated"') && actions.includes('data: { status: "approved", approvedAt: new Date() }'));
  check("S29 adjustment/payment change recomputes totals", actions.includes("recomputeCalculationTotals(calc.id)") && aggregateSrc.includes("export async function recomputeCalculationTotals"));
  check("S30 lock-after-approval gate in access layer", access.includes("export function canAddPayrollAdjustment") && access.includes("if (opts.locked) return accounting"));
  check("S31 transitions audited with the canonical action code", actions.includes("PAYROLL_ACTION_AUDIT[action]"));
  check("S32 aggregate never double-counts advance (advance + payments summed separately)",
    aggregateSrc.includes("advanceKopeks: advance") && aggregateSrc.includes("otherPaymentsKopeks: otherPayments") && aggregateSrc.includes("paidKopeks: agg.paidKopeks"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
