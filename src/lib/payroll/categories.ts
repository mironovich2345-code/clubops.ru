// Payroll CATEGORY model (STAGE 2). A "payroll category" drives the FORMULA; a "UI
// group" is only how the manager's period screen groups categories into cards. They are
// deliberately SEPARATE: several categories can share one card but never one formula.
//
// Расчётные категории (8) ≠ UI-карточки (5).
import type { PayrollCategory as FormulaCategory } from "@/lib/payroll/formulas";

// The 8 calculation categories (spec §2). "unknown" = a position we must NOT silently
// run a random formula for — it surfaces a problem and blocks the calc.
export const PAYROLL_CALC_CATEGORIES = [
  "club_manager",
  "sales_manager",
  "administrator",
  "night_manager",
  "gym_head_trainer",
  "gym_trainer",
  "group_head_trainer",
  "group_trainer",
] as const;
export type PayrollCalcCategory = (typeof PAYROLL_CALC_CATEGORIES)[number];
export type PayrollCalcCategoryOrUnknown = PayrollCalcCategory | "unknown";

export const CALC_CATEGORY_LABELS: Record<PayrollCalcCategory, string> = {
  club_manager: "Управляющий",
  sales_manager: "Менеджер продаж",
  administrator: "Администратор",
  night_manager: "Ночной менеджер",
  gym_head_trainer: "Старший тренер ТЗ",
  gym_trainer: "Тренер ТЗ",
  group_head_trainer: "Старший тренер ГП",
  group_trainer: "Тренер ГП",
};

// The 5 UI cards (spec §2/§9). "advances_card" is cross-category (all active employees).
export const PAYROLL_UI_GROUPS = ["manager_card", "administrative_card", "gym_trainers_card", "group_trainers_card", "advances_card"] as const;
export type PayrollUiGroup = (typeof PAYROLL_UI_GROUPS)[number];

export const UI_GROUP_LABELS: Record<PayrollUiGroup, string> = {
  manager_card: "Управляющий",
  administrative_card: "Административный состав",
  gym_trainers_card: "Тренеры ТЗ",
  group_trainers_card: "Тренеры ГП",
  advances_card: "Аванс",
};

/** ClubEmployee.position → calculation category. Non-standard/historical positions map
 * to "unknown" (never a random formula). Position is a typed key, not free text. */
export function payrollCategoryOfPosition(position: string | null | undefined): PayrollCalcCategoryOrUnknown {
  switch (position) {
    case "manager":
      return "club_manager";
    case "sales_manager":
      return "sales_manager";
    case "administrator":
      return "administrator";
    case "night_manager":
      return "night_manager";
    case "head_gym_trainer":
      return "gym_head_trainer";
    case "gym_trainer":
      return "gym_trainer";
    case "senior_group_trainer":
      return "group_head_trainer";
    case "group_trainer":
      return "group_trainer";
    default:
      return "unknown";
  }
}

/** Calculation category → the UI card it appears under (advances handled separately). */
export function payrollUiGroupOfCategory(category: PayrollCalcCategory): Exclude<PayrollUiGroup, "advances_card"> {
  switch (category) {
    case "club_manager":
      return "manager_card";
    case "sales_manager":
    case "administrator":
    case "night_manager":
      return "administrative_card";
    case "gym_head_trainer":
    case "gym_trainer":
      return "gym_trainers_card";
    case "group_head_trainer":
    case "group_trainer":
      return "group_trainers_card";
  }
}

/** The scheme-config family a category uses (for the resolver + role-compute). Head and
 * regular trainers share a family but keep distinct categories/formulas. */
export function formulaCategoryOfCalcCategory(category: PayrollCalcCategory): FormulaCategory {
  switch (category) {
    case "club_manager":
      return "manager";
    case "sales_manager":
    case "administrator":
    case "night_manager":
      return "admin";
    case "gym_head_trainer":
    case "gym_trainer":
      return "gym_trainer";
    case "group_head_trainer":
    case "group_trainer":
      return "group_trainer";
  }
}

export function isKnownCalcCategory(v: string): v is PayrollCalcCategory {
  return (PAYROLL_CALC_CATEGORIES as readonly string[]).includes(v);
}
