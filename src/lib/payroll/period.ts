// Pure payroll-period status machine (spec §3.4/§5). No illegal transitions; each
// action is gated to a role band. Mirrors the invoice/refund approval-table pattern.
import type { Role } from "@/lib/auth";
import type { PayrollPeriodStatus } from "@/lib/payroll/enums";

export type PayrollAction =
  | "submit" // manager → regional
  | "start_regional_review"
  | "return_for_correction"
  | "regional_approve"
  | "start_accounting_review"
  | "accounting_approve"
  | "mark_partially_paid"
  | "mark_paid"
  | "close";

export const PAYROLL_ACTION_LABELS: Record<PayrollAction, string> = {
  submit: "Отправить на согласование",
  start_regional_review: "Взять на проверку (регионал)",
  return_for_correction: "Вернуть на исправление",
  regional_approve: "Согласовать (регионал)",
  start_accounting_review: "Взять на проверку (бухгалтер)",
  accounting_approve: "Утвердить (бухгалтер)",
  mark_partially_paid: "Отметить частично выплаченным",
  mark_paid: "Отметить выплаченным",
  close: "Закрыть месяц",
};

export const PAYROLL_ACTION_AUDIT: Record<PayrollAction, string> = {
  submit: "payroll.period_submitted",
  start_regional_review: "payroll.period_regional_review",
  return_for_correction: "payroll.period_returned",
  regional_approve: "payroll.period_regional_approved",
  start_accounting_review: "payroll.period_accounting_review",
  accounting_approve: "payroll.period_approved",
  mark_partially_paid: "payroll.period_partially_paid",
  mark_paid: "payroll.period_paid",
  close: "payroll.period_closed",
};

type Rule = { from: PayrollPeriodStatus[]; to: PayrollPeriodStatus; roles: Role[] };

// Manager = manager; regional band = regional_director (owner/GD may act as escalation
// is out of scope here); accounting band = accountant/chief_accountant.
const REGIONAL: Role[] = ["regional_director"];
const ACCOUNTING: Role[] = ["accountant", "chief_accountant"];

const RULES: Record<PayrollAction, Rule> = {
  submit: { from: ["draft", "needs_correction"], to: "manager_submitted", roles: ["manager"] },
  start_regional_review: { from: ["manager_submitted"], to: "regional_review", roles: REGIONAL },
  return_for_correction: { from: ["manager_submitted", "regional_review", "accounting_review"], to: "needs_correction", roles: [...REGIONAL, ...ACCOUNTING] },
  regional_approve: { from: ["manager_submitted", "regional_review"], to: "regional_approved", roles: REGIONAL },
  start_accounting_review: { from: ["regional_approved"], to: "accounting_review", roles: ACCOUNTING },
  accounting_approve: { from: ["regional_approved", "accounting_review"], to: "approved", roles: ACCOUNTING },
  mark_partially_paid: { from: ["approved", "partially_paid"], to: "partially_paid", roles: ["manager", ...REGIONAL, ...ACCOUNTING] },
  mark_paid: { from: ["approved", "partially_paid"], to: "paid", roles: ["manager", ...REGIONAL, ...ACCOUNTING] },
  close: { from: ["paid", "partially_paid"], to: "closed", roles: [...REGIONAL, ...ACCOUNTING] },
};

export type TransitionResult = { ok: true; to: PayrollPeriodStatus } | { ok: false; error: string };

/** Pure decision: may `roles` perform `action` from `status`? Returns the target
 * status or an error. Direct edits after `approved` are blocked by the caller (the
 * period is locked; only adjustments via the accounting correction path apply). */
export function applyPayrollAction(action: PayrollAction, status: string, roles: readonly Role[]): TransitionResult {
  const rule = RULES[action];
  if (!rule) return { ok: false, error: "Неверное действие." };
  if (!(rule.from as string[]).includes(status)) return { ok: false, error: "Недопустимый переход статуса расчётного периода." };
  if (!roles.some((r) => rule.roles.includes(r))) return { ok: false, error: "Недостаточно прав для этого действия." };
  return { ok: true, to: rule.to };
}

export function availablePayrollActions(status: string, roles: readonly Role[]): PayrollAction[] {
  return (Object.keys(RULES) as PayrollAction[]).filter((a) => applyPayrollAction(a, status, roles).ok);
}

/** A period is LOCKED for direct calculation edits once accounting has approved it
 * (only accountant corrections via PayrollAdjustment apply thereafter). */
export function isPayrollPeriodLocked(status: string): boolean {
  return ["approved", "partially_paid", "paid", "closed"].includes(status);
}
export function isPayrollPeriodClosed(status: string): boolean {
  return status === "closed";
}
