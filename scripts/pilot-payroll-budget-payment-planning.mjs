// Pilot — Payroll → Salary Budget → Payment Planning (spec §32). Verifies the four numbers stay
// SEPARATE (forecast/budget/accrual/payment), the budget is never silently overwritten, an
// approved period creates an obligation (advances folded → no double count), remaining is exact,
// reversal is chief-only + append-only, legalEntity scope holds, and missing data warns (never a
// silent 0). Pure-helper mirrors + static guards over the shipped source. npm run pilot:payroll-budget-payment-planning
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => { try { return readFileSync(new URL(p, import.meta.url), "utf8"); } catch { return ""; } };
const R = (rub) => rub * 100;

// ---- mirrors of pure helpers ------------------------------------------------
function schemeGuaranteedBase(scheme) {
  switch (scheme.type) {
    case "fixed_salary": return { baseKopeks: scheme.params.baseKopeks, hasVariable: false };
    case "salary_by_shifts": return { baseKopeks: scheme.params.baseKopeks, hasVariable: true };
    case "salary_plus_percentage": return { baseKopeks: scheme.params.baseKopeks, hasVariable: true };
    case "revenue_percentage": return { baseKopeks: scheme.params.fixedKopeks, hasVariable: true };
    case "plan_adjusted_salary": return { baseKopeks: scheme.params.subscriptionsBaseKopeks + scheme.params.ptBaseKopeks, hasVariable: true };
    case "role_club_manager": return { baseKopeks: scheme.params.abBaseKopeks + scheme.params.ptBaseKopeks, hasVariable: true };
    case "role_sales_manager": return { baseKopeks: scheme.params.salaryFor15Kopeks, hasVariable: true };
    case "role_group_head_trainer": return { baseKopeks: scheme.params.fixedBonusKopeks, hasVariable: true };
    case "sales_percentage": case "profit_percentage": case "gym_trainer": case "hourly":
    case "role_administrator": case "role_night_manager": case "role_gym_trainer":
    case "role_gym_head_trainer": case "role_group_trainer": return { baseKopeks: 0, hasVariable: true };
    default: return { baseKopeks: 0, hasVariable: true };
  }
}
function forecastCategoryOfCalc(cat) {
  switch (cat) {
    case "club_manager": return "management";
    case "sales_manager": case "administrator": case "night_manager": return "administrative";
    case "gym_head_trainer": case "gym_trainer": return "gym_trainers";
    case "group_head_trainer": case "group_trainer": return "group_trainers";
    default: return "other";
  }
}
function computeSalaryBudgetVariance(budget, forecast) {
  return { varianceKopeks: budget - forecast, variancePercent: forecast > 0 ? ((budget - forecast) / forecast) * 100 : null };
}
function shouldProposeFromDrift(mode, variance, threshold = 5) {
  if (mode === "manual") return false;
  if (variance.variancePercent == null) return false;
  return Math.abs(variance.variancePercent) >= threshold;
}
function resolveObligationDueDate({ year, month, day, weekendRule }) {
  if (!day || day < 1 || day > 31) return null;
  const lastDay = new Date(year, month, 0).getDate();
  const d = new Date(year, month - 1, Math.min(day, lastDay));
  const dow = d.getDay();
  if (weekendRule === "shift_earlier") { if (dow === 6) d.setDate(d.getDate() - 1); else if (dow === 0) d.setDate(d.getDate() - 2); }
  else if (weekendRule === "shift_later") { if (dow === 6) d.setDate(d.getDate() + 2); else if (dow === 0) d.setDate(d.getDate() + 1); }
  return d;
}
function obligationStatusOf(amount, paid, dueDate, now) {
  if (paid >= amount && amount > 0) return "paid";
  if (paid > 0) return "partially_paid";
  if (dueDate && dueDate.getTime() <= now.getTime()) return "due";
  return "planned";
}
const canPropose = (roles) => roles.some((r) => r === "regional_director" || r === "owner" || r === "general_director");
const canApprove = (roles) => roles.some((r) => r === "owner" || r === "general_director");
const canReverse = (roles) => roles.includes("chief_accountant");
const SYNC_MODES = ["manual", "suggested", "auto_sync"];

function main() {
  // ===== WAVE 1 — forecast (number A) =====
  check("F1 fixed_salary → full base, no variable", (() => { const b = schemeGuaranteedBase({ type: "fixed_salary", params: { baseKopeks: R(50000) } }); return b.baseKopeks === R(50000) && b.hasVariable === false; })());
  check("F2 sales_percentage → 0 base, variable (never faked)", (() => { const b = schemeGuaranteedBase({ type: "sales_percentage", params: { rateBp: 400 } }); return b.baseKopeks === 0 && b.hasVariable === true; })());
  check("F3 salary_plus_percentage → base confident + variable flag", (() => { const b = schemeGuaranteedBase({ type: "salary_plus_percentage", params: { baseKopeks: R(30000) } }); return b.baseKopeks === R(30000) && b.hasVariable === true; })());
  check("F4 role_sales_manager → salaryFor15 base + variable", (() => { const b = schemeGuaranteedBase({ type: "role_sales_manager", params: { salaryFor15Kopeks: R(40000) } }); return b.baseKopeks === R(40000) && b.hasVariable === true; })());
  check("F5 role_club_manager → ab+pt base", (() => { const b = schemeGuaranteedBase({ type: "role_club_manager", params: { abBaseKopeks: R(20000), ptBaseKopeks: R(10000) } }); return b.baseKopeks === R(30000); })());
  check("F6 category rollup: manager→management", forecastCategoryOfCalc("club_manager") === "management");
  check("F7 category rollup: admin/sales/night→administrative", forecastCategoryOfCalc("administrator") === "administrative" && forecastCategoryOfCalc("sales_manager") === "administrative" && forecastCategoryOfCalc("night_manager") === "administrative");
  check("F8 category rollup: gym→gym_trainers, group→group_trainers", forecastCategoryOfCalc("gym_trainer") === "gym_trainers" && forecastCategoryOfCalc("group_head_trainer") === "group_trainers");
  check("F9 category rollup: unknown→other", forecastCategoryOfCalc("unknown") === "other");
  const fc = src("../src/lib/payroll/forecast.ts");
  check("F10 forecast marks partial + warns on missing scheme (no silent 0)", fc.includes('confidence = "partial"') && fc.includes('code: "no_scheme"'));
  check("F11 forecast warns on variable component", fc.includes('code: "variable_component"'));
  check("F12 forecast is READ-ONLY (no obligation import, no prisma writes)", !fc.includes('from "@/lib/payment-obligations"') && !fc.includes("prisma.budget") && !/prisma\.\w+\.(create|update|delete|upsert)/.test(fc));
  check("F13 forecast uses only committed scheme statuses", fc.includes('"approved"') && fc.includes('"active"') && fc.includes('"superseded"'));
  check("F14 exhaustive scheme guard (never silent 0 on new type)", fc.includes("const _never: never = scheme"));

  // ===== WAVE 2 — budget linkage (number B) + proposal =====
  check("V1 variance = budget − forecast", computeSalaryBudgetVariance(R(120000), R(100000)).varianceKopeks === R(20000));
  check("V2 variancePercent relative to forecast", Math.abs(computeSalaryBudgetVariance(R(120000), R(100000)).variancePercent - 20) < 1e-9);
  check("V3 variancePercent NULL when forecast 0 (not 0%)", computeSalaryBudgetVariance(R(120000), 0).variancePercent === null);
  check("V4 negative variance when forecast exceeds budget", computeSalaryBudgetVariance(R(90000), R(100000)).varianceKopeks === -R(10000));
  check("D1 drift: manual never proposes", shouldProposeFromDrift("manual", computeSalaryBudgetVariance(R(200000), R(100000))) === false);
  check("D2 drift: suggested proposes past threshold", shouldProposeFromDrift("suggested", computeSalaryBudgetVariance(R(120000), R(100000))) === true);
  check("D3 drift: below threshold does not propose", shouldProposeFromDrift("suggested", computeSalaryBudgetVariance(R(103000), R(100000))) === false);
  check("D4 drift: null percent never proposes", shouldProposeFromDrift("suggested", computeSalaryBudgetVariance(R(120000), 0)) === false);
  check("R1 propose: regional/owner/GD only", canPropose(["regional_director"]) && canPropose(["owner"]) && canPropose(["general_director"]) && !canPropose(["accountant"]) && !canPropose(["manager"]));
  check("R2 approve: owner/GD only (regional excluded)", canApprove(["owner"]) && canApprove(["general_director"]) && !canApprove(["regional_director"]) && !canApprove(["chief_accountant"]));
  check("S1 sync modes are manual|suggested|auto_sync", SYNC_MODES.length === 3 && SYNC_MODES.includes("suggested"));
  const bl = src("../src/lib/payroll/budget-linkage.ts");
  check("B1 five distinct numbers loaded (forecast/budget/accrued/paid/remaining)", bl.includes("forecastKopeks") && bl.includes("budgetKopeks") && bl.includes("accruedKopeks") && bl.includes("paidKopeks") && bl.includes("remainingKopeks"));
  check("B2 budget mutated ONLY on proposal approval (the single path)", bl.includes("decideBudgetChangeProposal") && bl.includes("prisma.budget.upsert") && bl.includes('status: "approved"'));
  check("B3 createBudgetChangeProposal does NOT touch Budget", (() => { const fn = bl.slice(bl.indexOf("export async function createBudgetChangeProposal"), bl.indexOf("export async function decideBudgetChangeProposal")); return !fn.includes("prisma.budget.upsert") && !fn.includes("prisma.budget.update"); })());
  check("B4 default sync mode is 'suggested' (never auto-overwrite)", src("../prisma/schema.prisma").includes('salaryBudgetSyncMode      String    @default("suggested")'));
  check("B5 proposal append-only (status flip, no delete)", bl.includes('status: "rejected"') && bl.includes('status: "approved"') && !bl.includes("prisma.budgetChangeProposal.delete"));
  const pa = src("../src/app/(app)/budgets/proposal-actions.ts");
  check("B6 propose action gated canProposeBudgetChange + club scope", pa.includes("canProposeBudgetChange(ctx.effectiveRoles)") && pa.includes("canAccessClub(ctx.user.id, clubId)"));
  check("B7 approve/reject gated canApproveBudgetChange", pa.includes("canApproveBudgetChange(ctx.effectiveRoles)"));
  check("B8 planning settings gated owner/GD + day clamp 1..28", pa.includes("updateSalaryPlanningSettings") && pa.includes("n < 1 || n > 28"));
  check("B9 UI labels all five numbers distinctly", src("../src/app/(app)/budgets/_components/SalaryBudgetPanel.tsx").includes("Прогноз") && src("../src/app/(app)/budgets/_components/SalaryBudgetPanel.tsx").includes("К выплате"));

  // ===== WAVE 3 — obligation (numbers C/D → calendar) =====
  check("O1 dueDate null when schedule day unset (never faked)", resolveObligationDueDate({ year: 2026, month: 8, day: null }) === null);
  check("O2 dueDate resolves from day", (() => { const d = resolveObligationDueDate({ year: 2026, month: 8, day: 10 }); return d && d.getDate() === 10 && d.getMonth() === 7; })());
  check("O3 day clamps to month length", (() => { const d = resolveObligationDueDate({ year: 2026, month: 2, day: 31 }); return d && d.getMonth() === 1 && d.getDate() === 28; })());
  check("O4 weekend shift_earlier moves Sat→Fri", (() => { const d = resolveObligationDueDate({ year: 2026, month: 8, day: 1, weekendRule: "shift_earlier" }); return d && d.getDay() !== 6 && d.getDay() !== 0; })());
  check("O5 status paid when paid ≥ amount", obligationStatusOf(R(100), R(100), null, new Date()) === "paid");
  check("O6 status partially_paid when 0 < paid < amount", obligationStatusOf(R(100), R(40), null, new Date()) === "partially_paid");
  check("O7 status due when unpaid + past dueDate", obligationStatusOf(R(100), 0, new Date(2020, 0, 1), new Date()) === "due");
  check("O8 status planned when unpaid + future/undated", obligationStatusOf(R(100), 0, null, new Date()) === "planned");
  const po = src("../src/lib/payroll/payment-obligation.ts");
  check("O9 obligation generated only for APPROVED+ periods", po.includes('OBLIGATION_ELIGIBLE_PERIOD_STATUSES = ["approved", "partially_paid", "paid", "closed"]') && po.includes("isObligationEligiblePeriod(period.status)"));
  check("O10 amount = Σ netPayableKopeks (advances folded → no double count)", po.includes("c.netPayableKopeks") && !po.includes("grossAccruedKopeks"));
  check("O11 remaining clamped ≥ 0 (overpayment never negative obligation)", po.includes("Math.max(0, s.amount - s.paid)"));
  check("O12 idempotent by idempotencyKey (no duplicates on re-run)", po.includes("idempotencyKey") && po.includes("prisma.payrollPaymentObligation.findUnique({ where: { idempotencyKey }"));
  check("O13 cancelled obligation never resurrected by regeneration", po.includes('existing.status === "cancelled"') && po.includes("res.skipped += 1"));
  check("O14 calendar row shows OUTSTANDING remaining, not gross (no double count)", po.includes("amountKopeks: r.remainingKopeks"));
  check("O15 calendar excludes cancelled + dateless + settled rows", po.includes('status: { not: "cancelled" }') && po.includes("dueDate: { not: null") && po.includes("remainingKopeks: { gt: 0 }"));
  check("O16 buildPayrollObligations WIRED (no longer returns [])", (() => { const pm = src("../src/lib/payment-obligations.ts"); const fn = pm.slice(pm.indexOf("export async function buildPayrollObligations")); return fn.includes("loadPayrollCalendarObligations") && !/buildPayrollObligations[\s\S]{0,120}return \[\];/.test(fn); })());
  check("O17 obligation generated on period approval", src("../src/app/(app)/payroll/periods/actions.ts").includes("generateObligationsForPeriod(periodId)") && src("../src/app/(app)/payroll/periods/actions.ts").includes('decision.to === "approved"'));
  check("O18 obligation refreshed on payment record + cancel", (() => { const a = src("../src/app/(app)/payroll/periods/actions.ts"); return (a.match(/refreshPeriodObligations\(/g) || []).length >= 3; })());
  check("O19 PayrollPaymentObligation carries legalEntityId + unique idempotencyKey", src("../prisma/schema.prisma").includes("model PayrollPaymentObligation") && src("../prisma/schema.prisma").includes("idempotencyKey      String    @unique"));
  check("O20 dueDate nullable in schema (record without faking a date)", /model PayrollPaymentObligation[\s\S]*?dueDate\s+DateTime\?/.test(src("../prisma/schema.prisma")));

  // ===== WAVE 4 — advances / partial / reversal / remaining =====
  check("W1 obligation cancellation is chief-accountant only", canReverse(["chief_accountant"]) && !canReverse(["accountant"]) && !canReverse(["owner"]));
  check("W2 cancelPayrollObligation requires a reason + append-only (status flip, no delete)", po.includes("Укажите причину отмены") && po.includes('status: "cancelled"') && !po.includes("payrollPaymentObligation.delete"));
  check("W3 existing advance/partial/remaining engine reused (recomputeCalculationTotals)", src("../src/app/(app)/payroll/periods/actions.ts").includes("recomputeCalculationTotals"));

  // ===== WAVE 5 — preflight / backfill =====
  const pf = src("../scripts/preflight-payroll-budget-payment-planning.mjs");
  check("P1 preflight is READ-ONLY (no update/create/delete)", !pf.includes(".update(") && !pf.includes(".create(") && !pf.includes(".delete("));
  check("P2 preflight checks legalEntity/dates/duplicates/overpay/negative/dateless/orphan", pf.includes("без юрлица") && pf.includes("idempotencyKey") && pf.includes("отрицательным остатком") && pf.includes("больше суммы"));
  const bf = src("../scripts/backfill-payroll-obligations.mjs");
  check("P3 backfill dry-run by default (--apply gate)", bf.includes('process.argv.includes("--apply")') && bf.includes("if (APPLY)"));
  check("P4 backfill idempotency-keyed + only APPROVED periods", bf.includes("idempotencyKey") && bf.includes('APPROVED = new Set(["approved", "partially_paid", "paid", "closed"])'));
  check("P5 backfill creates NO budget change", !bf.includes("prisma.budget.") && !bf.includes("budgetChangeProposal"));
  check("P6 backfill folds advances (netPayableKopeks, not gross)", bf.includes("netPayableKopeks") && !bf.includes("grossAccruedKopeks"));

  // ===== cross-cutting =====
  check("X1 additive migrations present (dev + prod)", src("../prisma/migrations/20260802130000_payroll_payment_obligation/migration.sql").includes("PayrollPaymentObligation") && src("../prisma/production/migrations/20260802130000_payroll_payment_obligation/migration.sql").includes("PayrollPaymentObligation"));
  check("X2 BudgetChangeProposal migration present (dev + prod)", src("../prisma/migrations/20260802120000_salary_budget_change_proposal/migration.sql").includes("BudgetChangeProposal") && src("../prisma/production/migrations/20260802120000_salary_budget_change_proposal/migration.sql").includes("BudgetChangeProposal"));
  check("X3 no schema DROP in the new migrations (non-destructive)", !src("../prisma/production/migrations/20260802130000_payroll_payment_obligation/migration.sql").includes("DROP TABLE") && !src("../prisma/production/migrations/20260802120000_salary_budget_change_proposal/migration.sql").includes("DROP TABLE"));
  check("X4 integer kopeks only in new pure helpers (no parseFloat)", !bl.includes("parseFloat") && !po.includes("parseFloat") && !fc.includes("parseFloat"));
  check("X5 Company salary/tax/schedule settings additive + defaulted", src("../prisma/schema.prisma").includes("salaryBudgetIncludesTaxes Boolean   @default(false)") && src("../prisma/schema.prisma").includes("payrollFinalDay           Int?"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
