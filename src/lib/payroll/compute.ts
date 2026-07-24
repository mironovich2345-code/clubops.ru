// Pure bridge from a validated pay scheme + structured period inputs to the engine
// in calc.ts. Dispatches on scheme type and returns the automatic amount + breakdown.
// No DB, no eval. This is what a PayrollCalculation snapshots and re-runs.
import * as calc from "@/lib/payroll/calc";
import type { CalcResult, GymPackage } from "@/lib/payroll/calc";
import type { SchemeParams } from "@/lib/payroll/scheme";

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
};

const zeroPart = { planKopeks: 0, factKopeks: 0 };

/** Dispatch a validated scheme + inputs to the right engine function. */
export function computeScheme(scheme: SchemeParams, input: PeriodInput): CalcResult {
  switch (scheme.type) {
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
