// Pay-scheme parameters: STRUCTURED + validated (never eval'd formula strings). Each
// scheme type has a typed params shape stored as JSON on EmployeePayScheme.paramsJson.
// Money = kopeks, percentages = basis points (bp). Defaults match spec §4.
import { PAYROLL_SCHEME_TYPES, type PayrollSchemeType, isKnown } from "@/lib/payroll/enums";

export const DEFAULT_SHIFT_NORM = 15; // 100% oklad = 15 shifts (spec §4.1) — configurable
export const DEFAULT_BELOW_PLAN_RATE_BP = 300; // 3% when plan not met
export const DEFAULT_AT_PLAN_RATE_BP = 400; // 4% when plan met
export const DEFAULT_GYM_LOW_RATE_BP = 4000; // 40% for packages ≤ threshold
export const DEFAULT_GYM_HIGH_RATE_BP = 5000; // 50% otherwise
export const DEFAULT_GYM_THRESHOLD_KOPEKS = 20000 * 100; // 20 000 ₽ inclusive
export const DEFAULT_TRAINER_PLAN_THRESHOLD_BP = 7000; // 70% of month plan to unlock last-month payout
export const DEFAULT_SENIOR_GROUP_SALES_BP = 1000; // 10%
export const DEFAULT_MAX_ADJUSTMENT_BP = 4000; // ±40% cap (manager plan-fact)
export const DEFAULT_MANUAL_REVIEW_DEVIATION_BP = 2000; // >20% deviation → manual decision

// --- typed params per scheme -------------------------------------------------
export type FixedSalaryParams = { baseKopeks: number };
export type SalaryByShiftsParams = { baseKopeks: number; shiftNorm: number };
export type SalaryPlusPercentageParams = { baseKopeks: number; shiftNorm: number; belowPlanRateBp: number; atPlanRateBp: number };
export type SalesPercentageParams = { rateBp: number };
export type HourlyParams = { hourlyRateKopeks: number };
export type GymTrainerParams = { lowRateBp: number; highRateBp: number; thresholdKopeks: number; planThresholdBp: number };
export type SeniorGroupParams = { fixedKopeks: number; salesRateBp: number };
export type PlanAdjustedParams = { subscriptionsBaseKopeks: number; ptBaseKopeks: number; maxAdjustmentBp: number; manualReviewDeviationBp: number };
export type RevenuePercentageParams = { fixedKopeks: number; subsPercentBp: number; ptPercentBp: number };
export type ProfitPercentageParams = { percentBp: number };

export type SchemeParams =
  | { type: "fixed_salary"; params: FixedSalaryParams }
  | { type: "salary_by_shifts"; params: SalaryByShiftsParams }
  | { type: "salary_plus_percentage"; params: SalaryPlusPercentageParams }
  | { type: "sales_percentage"; params: SalesPercentageParams }
  | { type: "hourly"; params: HourlyParams }
  | { type: "plan_adjusted_salary"; params: PlanAdjustedParams }
  | { type: "revenue_percentage"; params: RevenuePercentageParams }
  | { type: "profit_percentage"; params: ProfitPercentageParams }
  | { type: "mixed"; params: Record<string, unknown> };

// --- validation --------------------------------------------------------------
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nonNegInt = (v: unknown): number | null => { const n = num(v); return n != null && n >= 0 && Number.isInteger(n) ? n : null; };
const bp = (v: unknown): number | null => { const n = num(v); return n != null && n >= 0 && n <= 100000 && Number.isInteger(n) ? n : null; };

export type ValidateResult = { ok: true; scheme: SchemeParams } | { ok: false; error: string };

/**
 * Validate raw scheme params for a scheme type, filling documented defaults for
 * optional fields. Returns a typed SchemeParams or a user-safe error. Never eval's
 * anything; all inputs are bounded integers.
 */
export function validateSchemeParams(schemeType: string, raw: unknown): ValidateResult {
  if (!isKnown(PAYROLL_SCHEME_TYPES, schemeType)) return { ok: false, error: "Неизвестный тип схемы оплаты." };
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const err = (m: string): ValidateResult => ({ ok: false, error: m });

  switch (schemeType as PayrollSchemeType) {
    case "fixed_salary": {
      const baseKopeks = nonNegInt(p.baseKopeks);
      if (baseKopeks == null) return err("Укажите оклад (целое число копеек ≥ 0).");
      return { ok: true, scheme: { type: "fixed_salary", params: { baseKopeks } } };
    }
    case "salary_by_shifts": {
      const baseKopeks = nonNegInt(p.baseKopeks);
      const shiftNorm = num(p.shiftNorm) ?? DEFAULT_SHIFT_NORM;
      if (baseKopeks == null) return err("Укажите оклад.");
      if (!(shiftNorm > 0)) return err("Норматив смен должен быть больше нуля.");
      return { ok: true, scheme: { type: "salary_by_shifts", params: { baseKopeks, shiftNorm } } };
    }
    case "salary_plus_percentage": {
      const baseKopeks = nonNegInt(p.baseKopeks);
      const shiftNorm = num(p.shiftNorm) ?? DEFAULT_SHIFT_NORM;
      const belowPlanRateBp = bp(p.belowPlanRateBp) ?? DEFAULT_BELOW_PLAN_RATE_BP;
      const atPlanRateBp = bp(p.atPlanRateBp) ?? DEFAULT_AT_PLAN_RATE_BP;
      if (baseKopeks == null) return err("Укажите оклад.");
      if (!(shiftNorm > 0)) return err("Норматив смен должен быть больше нуля.");
      return { ok: true, scheme: { type: "salary_plus_percentage", params: { baseKopeks, shiftNorm, belowPlanRateBp, atPlanRateBp } } };
    }
    case "sales_percentage": {
      const rateBp = bp(p.rateBp);
      if (rateBp == null) return err("Укажите процент с продаж (в базисных пунктах).");
      return { ok: true, scheme: { type: "sales_percentage", params: { rateBp } } };
    }
    case "hourly": {
      const hourlyRateKopeks = nonNegInt(p.hourlyRateKopeks);
      if (hourlyRateKopeks == null) return err("Укажите ставку за час.");
      return { ok: true, scheme: { type: "hourly", params: { hourlyRateKopeks } } };
    }
    case "plan_adjusted_salary": {
      const subscriptionsBaseKopeks = nonNegInt(p.subscriptionsBaseKopeks);
      const ptBaseKopeks = nonNegInt(p.ptBaseKopeks);
      const maxAdjustmentBp = bp(p.maxAdjustmentBp) ?? DEFAULT_MAX_ADJUSTMENT_BP;
      const manualReviewDeviationBp = bp(p.manualReviewDeviationBp) ?? DEFAULT_MANUAL_REVIEW_DEVIATION_BP;
      if (subscriptionsBaseKopeks == null || ptBaseKopeks == null) return err("Укажите окладные части (абонементы и ПТ).");
      return { ok: true, scheme: { type: "plan_adjusted_salary", params: { subscriptionsBaseKopeks, ptBaseKopeks, maxAdjustmentBp, manualReviewDeviationBp } } };
    }
    case "revenue_percentage": {
      const fixedKopeks = nonNegInt(p.fixedKopeks) ?? 0;
      const subsPercentBp = bp(p.subsPercentBp) ?? 0;
      const ptPercentBp = bp(p.ptPercentBp) ?? 0;
      // Senior group trainer uses fixed + salesRateBp; accept it as subsPercentBp too.
      return { ok: true, scheme: { type: "revenue_percentage", params: { fixedKopeks, subsPercentBp, ptPercentBp } } };
    }
    case "profit_percentage": {
      const percentBp = bp(p.percentBp);
      if (percentBp == null) return err("Укажите процент от прибыли.");
      return { ok: true, scheme: { type: "profit_percentage", params: { percentBp } } };
    }
    case "mixed":
      return { ok: true, scheme: { type: "mixed", params: p } };
  }
}
