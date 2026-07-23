// Payroll module — canonical enums (stored as TEXT; SQLite has no enums). All
// values are validated server-side. Money is integer KOPEKS everywhere; percentages
// are integer BASIS POINTS (bp): 100% = 10000 bp, 3% = 300 bp, 40% = 4000 bp.

// Employee positions. Superset of the existing ClubEmployee.position labels (manager,
// administrator, gym_trainer, group_trainer, night_manager) + the payroll-only ones.
// The calculation SCHEME is assigned per employee/club (below), not derived rigidly
// from the position — so a position is a label, the scheme drives the formula.
export const PAYROLL_POSITIONS = [
  "manager", // управляющий (club head)
  "administrator",
  "night_manager",
  "head_gym_trainer", // старший тренер тренажёрного зала
  "gym_trainer",
  "senior_group_trainer", // старший тренер групповых программ
  "group_trainer",
  "regional_director",
] as const;
export type PayrollPosition = (typeof PAYROLL_POSITIONS)[number];

export const PAYROLL_POSITION_LABELS: Record<string, string> = {
  manager: "Управляющий",
  administrator: "Администратор",
  night_manager: "Ночной менеджер",
  head_gym_trainer: "Старший тренер тренажёрного зала",
  gym_trainer: "Тренер тренажёрного зала",
  senior_group_trainer: "Старший тренер групповых программ",
  group_trainer: "Тренер групповых программ",
  regional_director: "Региональный директор",
};

// Pay-scheme types (spec §3.3). The engine dispatches on this value.
export const PAYROLL_SCHEME_TYPES = [
  "fixed_salary",
  "salary_by_shifts",
  "salary_plus_percentage", // salary_by_shifts + personal-sales %
  "sales_percentage",
  "hourly",
  "plan_adjusted_salary", // manager plan-fact (Scheme A)
  "revenue_percentage", // manager Scheme B / senior group trainer / regional revenue %
  "profit_percentage", // regional profit %
  "mixed",
] as const;
export type PayrollSchemeType = (typeof PAYROLL_SCHEME_TYPES)[number];

export const PAYROLL_SCHEME_LABELS: Record<string, string> = {
  fixed_salary: "Фиксированный оклад",
  salary_by_shifts: "Оклад по сменам",
  salary_plus_percentage: "Оклад по сменам + процент с продаж",
  sales_percentage: "Процент с продаж",
  hourly: "Почасовая (часы × ставка)",
  plan_adjusted_salary: "Оклад по плану-факту",
  revenue_percentage: "Процент от выручки",
  profit_percentage: "Процент от прибыли",
  mixed: "Смешанная",
};

// Payroll period status machine (spec §3.4). Transitions are guarded in period.ts.
export const PAYROLL_PERIOD_STATUSES = [
  "draft",
  "manager_submitted",
  "regional_review",
  "needs_correction",
  "regional_approved",
  "accounting_review",
  "approved",
  "partially_paid",
  "paid",
  "closed",
] as const;
export type PayrollPeriodStatus = (typeof PAYROLL_PERIOD_STATUSES)[number];

export const PAYROLL_PERIOD_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик",
  manager_submitted: "Отправлен управляющим",
  regional_review: "На проверке у регионала",
  needs_correction: "Требует исправления",
  regional_approved: "Согласован регионалом",
  accounting_review: "На проверке у бухгалтера",
  approved: "Утверждён",
  partially_paid: "Частично выплачен",
  paid: "Выплачен",
  closed: "Закрыт",
};

// Per-employee calculation status.
export const PAYROLL_CALCULATION_STATUSES = ["draft", "calculated", "approved", "paid", "closed"] as const;
export type PayrollCalculationStatus = (typeof PAYROLL_CALCULATION_STATUSES)[number];

// Adjustments (bonus / penalty / recoveries / correction). Direction: does it add to
// or subtract from the employee's payable.
export const PAYROLL_ADJUSTMENT_TYPES = [
  "bonus",
  "penalty",
  "overpayment_recovery",
  "shortage_recovery",
  "trainer_credit_recovery",
  "correction",
  "other",
] as const;
export type PayrollAdjustmentType = (typeof PAYROLL_ADJUSTMENT_TYPES)[number];
export const ADJUSTMENT_DIRECTIONS = ["credit", "debit"] as const; // credit = +payable, debit = −payable
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];

export const PAYROLL_ADVANCE_STATUSES = ["requested", "approved", "paid", "rejected", "canceled"] as const;
export type PayrollAdvanceStatus = (typeof PAYROLL_ADVANCE_STATUSES)[number];

// Payments.
export const PAYROLL_PAYMENT_METHODS = ["cash", "bank"] as const;
export type PayrollPaymentMethod = (typeof PAYROLL_PAYMENT_METHODS)[number];
export const PAYROLL_PAYMENT_SOURCES = ["club_cash", "regional_cash", "bank_account"] as const;
export type PayrollPaymentSource = (typeof PAYROLL_PAYMENT_SOURCES)[number];
export const PAYROLL_PAYMENT_STATUSES = ["pending", "confirmed", "canceled"] as const;
export type PayrollPaymentStatus = (typeof PAYROLL_PAYMENT_STATUSES)[number];

// Employee financial obligations (debts).
export const OBLIGATION_DIRECTIONS = ["employee_owes_company", "company_owes_employee"] as const;
export type ObligationDirection = (typeof OBLIGATION_DIRECTIONS)[number];
export const OBLIGATION_REASONS = [
  "overpayment",
  "underpayment",
  "advance",
  "shortage",
  "trainer_credit",
  "salary_remainder",
  "correction",
  "other",
] as const;
export type ObligationReason = (typeof OBLIGATION_REASONS)[number];
export const OBLIGATION_STATUSES = ["open", "partially_settled", "settled", "written_off"] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

// Basis-point / percent helpers.
export const BP_PER_100_PERCENT = 10000;
export const isKnown = <T extends readonly string[]>(list: T, v: unknown): v is T[number] =>
  typeof v === "string" && (list as readonly string[]).includes(v);
