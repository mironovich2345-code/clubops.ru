// Pure payroll calculation engine. No DB, no side effects, no eval. Every function
// takes structured params (validated in scheme.ts) + period inputs and returns the
// automatic amount in KOPEKS plus a human-readable breakdown (расшифровка). Money
// results are rounded UP to whole rubles via ceilToRubleKopeks (shared with refunds).
import { ceilToRubleKopeks } from "@/lib/refund-membership";
import { BP_PER_100_PERCENT } from "@/lib/payroll/enums";
import type {
  SalaryByShiftsParams, SalaryPlusPercentageParams, HourlyParams, SeniorGroupParams,
  PlanAdjustedParams, RevenuePercentageParams, ProfitPercentageParams, GymTrainerParams,
} from "@/lib/payroll/scheme";

export type BreakdownLine = { label: string; valueKopeks?: number; text?: string };
export type CalcFlags = { needsManualReview?: boolean };
export type CalcResult = { amountKopeks: number; breakdown: BreakdownLine[]; flags: CalcFlags; warnings: string[] };

const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
const applyBp = (kopeks: number, bp: number) => ceilToRubleKopeks(Math.round((kopeks * bp) / BP_PER_100_PERCENT));

// --- salary by shifts (spec §4.1) --------------------------------------------
/** base × actualShifts / shiftNorm (rounded up to rubles). */
export function calcSalaryByShifts(p: SalaryByShiftsParams, input: { actualShifts: number }): CalcResult {
  const shifts = Math.max(0, input.actualShifts);
  const norm = p.shiftNorm > 0 ? p.shiftNorm : 1;
  const amount = ceilToRubleKopeks(Math.round((p.baseKopeks * shifts) / norm));
  return {
    amountKopeks: amount,
    breakdown: [
      { label: "Оклад (100% = норматив смен)", valueKopeks: p.baseKopeks },
      { label: `Смены: ${shifts} из ${norm}`, text: `${shifts}/${norm}` },
      { label: "Оклад по сменам", valueKopeks: amount },
    ],
    flags: {},
    warnings: [],
  };
}

/** Personal-sales commission: netSales × rate; rate depends on plan met (spec §4.1). */
export function calcSalesCommission(rateBp: number, netPersonalSalesKopeks: number): CalcResult {
  const base = Math.max(0, netPersonalSalesKopeks);
  const amount = applyBp(base, rateBp);
  return {
    amountKopeks: amount,
    breakdown: [
      { label: "Чистые личные продажи (за вычетом возвратов)", valueKopeks: base },
      { label: `Процент с продаж (${pct(rateBp)})`, valueKopeks: amount },
    ],
    flags: {},
    warnings: [],
  };
}

/** Manager/administrator (§4.1): salary-by-shifts + personal-sales %. planMet picks the rate. */
export function calcSalaryPlusPercentage(
  p: SalaryPlusPercentageParams,
  input: { actualShifts: number; netPersonalSalesKopeks: number; planMet: boolean },
): CalcResult {
  const shiftPart = calcSalaryByShifts({ baseKopeks: p.baseKopeks, shiftNorm: p.shiftNorm }, input);
  const rateBp = input.planMet ? p.atPlanRateBp : p.belowPlanRateBp;
  const salesPart = calcSalesCommission(rateBp, input.netPersonalSalesKopeks);
  const amount = shiftPart.amountKopeks + salesPart.amountKopeks;
  return {
    amountKopeks: amount,
    breakdown: [
      ...shiftPart.breakdown,
      { label: `План продаж ${input.planMet ? "выполнен" : "не выполнен"}`, text: input.planMet ? "да" : "нет" },
      ...salesPart.breakdown,
      { label: "Автоматически начислено", valueKopeks: amount },
    ],
    flags: {},
    warnings: [],
  };
}

// --- hourly group trainer (spec §4.3) ----------------------------------------
export function calcHourly(p: HourlyParams, input: { hours: number }): CalcResult {
  const hours = Math.max(0, input.hours);
  const amount = ceilToRubleKopeks(Math.round(p.hourlyRateKopeks * hours));
  return {
    amountKopeks: amount,
    breakdown: [
      { label: "Ставка за час/занятие", valueKopeks: p.hourlyRateKopeks },
      { label: `Часы (занятия): ${hours}`, text: String(hours) },
      { label: "Начислено (часы × ставка)", valueKopeks: amount },
    ],
    flags: {},
    warnings: [],
  };
}

// --- senior group trainer (spec §4.4): fixed + % of sales --------------------
export function calcSeniorGroup(p: SeniorGroupParams, input: { salesKopeks: number }): CalcResult {
  const sales = Math.max(0, input.salesKopeks);
  const percentPart = applyBp(sales, p.salesRateBp);
  const amount = p.fixedKopeks + percentPart;
  return {
    amountKopeks: amount,
    breakdown: [
      { label: "Фиксированный оклад", valueKopeks: p.fixedKopeks },
      { label: "Продажи", valueKopeks: sales },
      { label: `Процент с продаж (${pct(p.salesRateBp)})`, valueKopeks: percentPart },
      { label: "Итого начислено", valueKopeks: amount },
    ],
    flags: {},
    warnings: [],
  };
}

// --- gym trainer (spec §4.2): per-package rate by threshold ------------------
// `rateBp` overrides the threshold rule (индивидуальная ставка) when provided.
export type GymPackage = { contractAmountKopeks: number; sessionCount: number; refundKopeks?: number; rateBp?: number | null };

/** Trainer income for one package: net contract × rate; rate = custom override else by threshold. */
export function calcGymPackage(p: GymTrainerParams, pkg: GymPackage): { incomeKopeks: number; sessionPriceKopeks: number; rateBp: number } {
  const net = Math.max(0, pkg.contractAmountKopeks - (pkg.refundKopeks ?? 0));
  const rateBp = pkg.rateBp != null ? pkg.rateBp : pkg.contractAmountKopeks <= p.thresholdKopeks ? p.lowRateBp : p.highRateBp;
  const sessionPrice = pkg.sessionCount > 0 ? Math.round(pkg.contractAmountKopeks / pkg.sessionCount) : 0;
  const income = applyBp(net, rateBp);
  return { incomeKopeks: income, sessionPriceKopeks: sessionPrice, rateBp };
}

/** Sum of package incomes for the month. Payout GATE (planMet) is a SEPARATE flag. */
export function calcGymTrainer(p: GymTrainerParams, input: { packages: GymPackage[]; planCompletionBp: number }): CalcResult {
  let total = 0;
  const lines: BreakdownLine[] = [];
  for (const pkg of input.packages) {
    const r = calcGymPackage(p, pkg);
    total += r.incomeKopeks;
    lines.push({ label: `Пакет ${pkg.contractAmountKopeks / 100} ₽ × ${pct(r.rateBp)} (цена занятия ${(r.sessionPriceKopeks / 100).toFixed(0)} ₽)`, valueKopeks: r.incomeKopeks });
  }
  const planMet = input.planCompletionBp >= p.planThresholdBp;
  return {
    amountKopeks: total,
    breakdown: [
      ...lines,
      { label: `Порог пакета: ${(p.thresholdKopeks / 100).toFixed(0)} ₽ (≤ ${pct(p.lowRateBp)}, > ${pct(p.highRateBp)})`, text: "" },
      { label: `Выполнение плана продаж месяца выплаты: ${pct(input.planCompletionBp)} (порог ${pct(p.planThresholdBp)})`, text: planMet ? "выплата разрешена" : "выплата удерживается" },
      { label: "Начислено по продажам", valueKopeks: total },
    ],
    flags: {},
    warnings: planMet ? [] : ["Выплата продаж прошлого месяца удерживается: план месяца выплаты не выполнен на 70%."],
  };
}

/** Trainer credit (spec §4.2): paid-but-not-provided sessions. Independent of the 70% gate. */
export function calcTrainerCredit(input: { paidSessions: number; providedSessions: number; sessionPriceKopeks: number }): {
  allowedPayoutKopeks: number; providedValueKopeks: number; paidValueKopeks: number; overpaidKopeks: number; unprovidedSessions: number;
} {
  const paid = Math.max(0, input.paidSessions);
  const provided = Math.min(paid, Math.max(0, input.providedSessions));
  const price = Math.max(0, input.sessionPriceKopeks);
  const providedValue = provided * price;
  const paidValue = paid * price;
  return {
    allowedPayoutKopeks: providedValue,
    providedValueKopeks: providedValue,
    paidValueKopeks: paidValue,
    overpaidKopeks: Math.max(0, paidValue - providedValue),
    unprovidedSessions: Math.max(0, paid - provided),
  };
}

// --- manager plan-fact scheme A (spec §4.5) ----------------------------------
/**
 * Adjustment (bp) for a plan/fact part: deviation = 100% − completion. Adjustment
 * magnitude = min(cap, 200bp × ceil(|deviation%|)), signed negative when under plan.
 * >20% deviation flags manual review. Verified vs examples: 68.78%→−40% ; 98.90%→−4%.
 */
export function planFactAdjustmentBp(
  factKopeks: number, planKopeks: number,
  opts: { maxAdjustmentBp: number; manualReviewDeviationBp: number },
): { adjustmentBp: number; completionBp: number; deviationBp: number; needsManualReview: boolean; warning?: string } {
  if (planKopeks <= 0) {
    return { adjustmentBp: 0, completionBp: 0, deviationBp: BP_PER_100_PERCENT, needsManualReview: true, warning: "План не задан или равен нулю — требуется ручное решение." };
  }
  const completion = factKopeks / planKopeks;
  const completionBp = Math.max(0, Math.round(completion * BP_PER_100_PERCENT));
  const deviationPct = (1 - completion) * 100; // + = under, − = over
  const magnitudeBp = Math.min(opts.maxAdjustmentBp, 200 * Math.ceil(Math.abs(deviationPct)));
  const adjustmentBp = deviationPct >= 0 ? -magnitudeBp : magnitudeBp;
  const deviationBp = Math.round(Math.abs(deviationPct) * 100);
  const needsManualReview = Math.abs(deviationPct) * 100 > opts.manualReviewDeviationBp;
  return { adjustmentBp, completionBp, deviationBp, needsManualReview };
}

function planFactPart(label: string, baseKopeks: number, factKopeks: number, planKopeks: number, opts: { maxAdjustmentBp: number; manualReviewDeviationBp: number }) {
  const a = planFactAdjustmentBp(factKopeks, planKopeks, opts);
  const partKopeks = ceilToRubleKopeks(Math.round((baseKopeks * (BP_PER_100_PERCENT + a.adjustmentBp)) / BP_PER_100_PERCENT));
  const lines: BreakdownLine[] = [
    { label: `${label}: окладная часть`, valueKopeks: baseKopeks },
    { label: `${label}: план`, valueKopeks: planKopeks },
    { label: `${label}: факт`, valueKopeks: factKopeks },
    { label: `${label}: выполнение`, text: pct(a.completionBp) },
    { label: `${label}: корректировка`, text: `${a.adjustmentBp >= 0 ? "+" : ""}${pct(a.adjustmentBp)}` },
    { label: `${label}: итог части`, valueKopeks: partKopeks },
  ];
  return { partKopeks, lines, needsManualReview: a.needsManualReview, warning: a.warning };
}

export function calcManagerPlanFact(
  p: PlanAdjustedParams,
  input: { subscriptions: { planKopeks: number; factKopeks: number }; personalTraining: { planKopeks: number; factKopeks: number } },
): CalcResult {
  const opts = { maxAdjustmentBp: p.maxAdjustmentBp, manualReviewDeviationBp: p.manualReviewDeviationBp };
  const subs = planFactPart("Абонементы", p.subscriptionsBaseKopeks, input.subscriptions.factKopeks, input.subscriptions.planKopeks, opts);
  const pt = planFactPart("ПТ", p.ptBaseKopeks, input.personalTraining.factKopeks, input.personalTraining.planKopeks, opts);
  const amount = subs.partKopeks + pt.partKopeks;
  const warnings = [subs.warning, pt.warning].filter((w): w is string => Boolean(w));
  return {
    amountKopeks: amount,
    breakdown: [...subs.lines, ...pt.lines, { label: "Итого начислено (оклад по плану-факту)", valueKopeks: amount }],
    flags: { needsManualReview: subs.needsManualReview || pt.needsManualReview },
    warnings,
  };
}

// --- manager revenue-% scheme B / regional revenue-% (spec §4.5 B, §4.6) -----
export function calcRevenuePercentage(
  p: RevenuePercentageParams,
  input: { subscriptionsRevenueKopeks: number; ptRevenueKopeks: number },
): CalcResult {
  const subsPart = applyBp(Math.max(0, input.subscriptionsRevenueKopeks), p.subsPercentBp);
  const ptPart = applyBp(Math.max(0, input.ptRevenueKopeks), p.ptPercentBp);
  const amount = p.fixedKopeks + subsPart + ptPart;
  return {
    amountKopeks: amount,
    breakdown: [
      { label: "Фиксированный оклад", valueKopeks: p.fixedKopeks },
      { label: `Абонементы × ${pct(p.subsPercentBp)}`, valueKopeks: subsPart },
      { label: `ПТ × ${pct(p.ptPercentBp)}`, valueKopeks: ptPart },
      { label: "Итого начислено", valueKopeks: amount },
    ],
    flags: {},
    warnings: [],
  };
}

// --- regional director profit-% (spec §4.6) — city-level base is precomputed --
export function calcProfitPercentage(p: ProfitPercentageParams, input: { cityProfitKopeks: number }): CalcResult {
  const base = Math.max(0, input.cityProfitKopeks);
  const amount = applyBp(base, p.percentBp);
  return {
    amountKopeks: amount,
    breakdown: [
      { label: "Прибыль города", valueKopeks: base },
      { label: `Процент от прибыли (${pct(p.percentBp)})`, valueKopeks: amount },
    ],
    flags: {},
    warnings: [],
  };
}

// --- streak bonus (spec §4.5) ------------------------------------------------
export function streakBonusKopeks(consecutiveMonths: number, tiers: { months: number; bonusKopeks: number }[]): number {
  let best = 0;
  for (const t of tiers) if (consecutiveMonths >= t.months) best = Math.max(best, t.bonusKopeks);
  return best;
}
export const DEFAULT_STREAK_TIERS = [
  { months: 2, bonusKopeks: 10000 * 100 },
  { months: 3, bonusKopeks: 15000 * 100 },
  { months: 4, bonusKopeks: 20000 * 100 },
];

// --- aggregation: automatic + adjustments → gross/net/remaining/debt ----------
export type AdjustmentInput = { direction: "credit" | "debit"; amountKopeks: number };
export function aggregateCalculation(input: {
  automaticKopeks: number;
  adjustments: AdjustmentInput[]; // bonuses (credit) / penalties + recoveries (debit)
  advanceKopeks: number; // already paid as advance (part of paid)
  otherPaymentsKopeks: number; // other confirmed payments
}): { grossAccruedKopeks: number; netPayableKopeks: number; paidKopeks: number; remainingKopeks: number; employeeDebtKopeks: number; companyDebtKopeks: number } {
  const credits = input.adjustments.filter((a) => a.direction === "credit").reduce((s, a) => s + a.amountKopeks, 0);
  const debits = input.adjustments.filter((a) => a.direction === "debit").reduce((s, a) => s + a.amountKopeks, 0);
  const grossAccrued = input.automaticKopeks + credits - debits;
  const netPayable = grossAccrued; // управленческий учёт: no statutory withholding here
  const paid = input.advanceKopeks + input.otherPaymentsKopeks;
  const remaining = netPayable - paid;
  return {
    grossAccruedKopeks: grossAccrued,
    netPayableKopeks: netPayable,
    paidKopeks: paid,
    remainingKopeks: remaining,
    // remaining > 0 → company still owes the employee; < 0 → employee was overpaid.
    employeeDebtKopeks: remaining < 0 ? -remaining : 0,
    companyDebtKopeks: remaining > 0 ? remaining : 0,
  };
}
