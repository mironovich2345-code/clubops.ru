// Pure bridge from a validated pay scheme + structured period inputs to the engine
// in calc.ts. Dispatches on scheme type and returns the automatic amount + breakdown.
// No DB, no eval. This is what a PayrollCalculation snapshots and re-runs.
import * as calc from "@/lib/payroll/calc";
import type { CalcResult, GymPackage } from "@/lib/payroll/calc";
import type { SchemeParams } from "@/lib/payroll/scheme";
import { isRoleCategoryScheme } from "@/lib/payroll/enums";
import { computeRoleCategoryScheme } from "@/lib/payroll/role-compute";

export type PeriodInput = {
  actualShifts?: number;
  hours?: number;
  netPersonalSalesKopeks?: number;
  planMet?: boolean;
  salesKopeks?: number;
  subscriptions?: { planKopeks: number; factKopeks: number };
  personalTraining?: { planKopeks: number; factKopeks: number };
  subscriptionsRevenueKopeks?: number;
  ptRevenueKopeks?: number;
  cityProfitKopeks?: number;
  manualAmountKopeks?: number;
  // Gym trainer (spec §4.2): per-package inputs + this-month plan completion (the 70%
  // payout gate — SEPARATE from the trainer credit, which is provided-vs-paid sessions).
  gymPackages?: GymPackage[];
  planCompletionBp?: number;
  // --- role-categories engine v2 inputs (STAGE 3–8) ---
  normShifts?: number; // производственная норма (контроль, для админа/управляющего)
  clubPlanCompletionBp?: number; // выполнение ОБЩЕГО плана клуба (менеджеры/ночные)
  clubPtCompletionBp?: number; // выполнение общего плана ПТ клуба (старший ТЗ)
  personalSalesKopeks?: number; // личная выручка (до возвратов)
  returnsKopeks?: number; // возвраты по его продажам
  newSalesKopeks?: number; // тренер ТЗ: продажи новым клиентам
  renewalSalesKopeks?: number; // тренер ТЗ: продления
  trainerCreditKopeks?: number; // кредит тренера — ИНФОРМАТИВНО
  clubGroupSalesKopeks?: number; // старший ГП: вся выручка ГП клуба (после возвратов)
};

const zeroPart = { planKopeks: 0, factKopeks: 0 };

/** Dispatch a validated scheme + inputs to the right engine function. Role-categories
 * (v2) schemes route to the pure per-category functions in formulas.ts — this is the
 * SINGLE calc point; there is no parallel engine. */
export function computeScheme(scheme: SchemeParams, input: PeriodInput): CalcResult {
  // Role-categories engine v2 → formulas.ts (handled below, after the legacy switch).
  if (isRoleCategoryScheme(scheme.type)) return computeRoleCategoryScheme(scheme, input);
  switch (scheme.type) {
    case "role_club_manager":
    case "role_administrator":
    case "role_sales_manager":
    case "role_night_manager":
    case "role_gym_trainer":
    case "role_gym_head_trainer":
    case "role_group_trainer":
    case "role_group_head_trainer":
      return computeRoleCategoryScheme(scheme, input); // unreachable (handled above) — keeps the switch total
    case "fixed_salary":
      return {
        amountKopeks: scheme.params.baseKopeks,
        breakdown: [{ label: "Фиксированный оклад", valueKopeks: scheme.params.baseKopeks }],
        flags: {},
        warnings: [],
      };
    case "salary_by_shifts":
      return calc.calcSalaryByShifts(scheme.params, { actualShifts: input.actualShifts ?? 0 });
    case "salary_plus_percentage":
      return calc.calcSalaryPlusPercentage(scheme.params, {
        actualShifts: input.actualShifts ?? 0,
        netPersonalSalesKopeks: input.netPersonalSalesKopeks ?? 0,
        planMet: input.planMet ?? false,
      });
    case "sales_percentage":
      return calc.calcSalesCommission(scheme.params.rateBp, input.salesKopeks ?? 0);
    case "hourly":
      return calc.calcHourly(scheme.params, { hours: input.hours ?? 0 });
    case "plan_adjusted_salary":
      return calc.calcManagerPlanFact(scheme.params, {
        subscriptions: input.subscriptions ?? zeroPart,
        personalTraining: input.personalTraining ?? zeroPart,
      });
    case "revenue_percentage":
      return calc.calcRevenuePercentage(scheme.params, {
        subscriptionsRevenueKopeks: input.subscriptionsRevenueKopeks ?? 0,
        ptRevenueKopeks: input.ptRevenueKopeks ?? 0,
      });
    case "profit_percentage":
      return calc.calcProfitPercentage(scheme.params, { cityProfitKopeks: input.cityProfitKopeks ?? 0 });
    case "gym_trainer":
      return calc.calcGymTrainer(scheme.params, { packages: input.gymPackages ?? [], planCompletionBp: input.planCompletionBp ?? 0 });
    case "mixed":
      return {
        amountKopeks: Math.max(0, input.manualAmountKopeks ?? 0),
        breakdown: [{ label: "Смешанная схема — сумма введена вручную", valueKopeks: Math.max(0, input.manualAmountKopeks ?? 0) }],
        flags: { needsManualReview: true },
        warnings: input.manualAmountKopeks == null ? ["Смешанная схема: укажите сумму вручную."] : [],
      };
  }
}
