// Per-category payroll formulas (spec §3–§10). PURE + CONFIGURABLE — no rates, plans,
// percents or salary parts are hardcoded; every number comes from the scheme config
// (paramsJson). Money is integer KOPEKS; percentages are integer BASIS POINTS (bp):
// 100% = 10000 bp, 40% = 4000 bp, 3% = 300 bp. These functions are the real
// category-specific engine the UI/compute layer feeds snapshotted scheme params into —
// they replace "one universal formula" for all roles.

export const BP = 10000; // 100%

export function clampBp(value: number, minBp: number, maxBp: number): number {
  return Math.max(minBp, Math.min(maxBp, value));
}

/** Plan completion in bp: fact / plan × 100%. plan ≤ 0 → treated as 100% (no plan set). */
export function completionBp(planKopeks: number, factKopeks: number): number {
  if (!Number.isFinite(planKopeks) || planKopeks <= 0) return BP;
  return Math.round((factKopeks / planKopeks) * BP);
}

/** A configurable percent tier: apply `percentBp` when completion ≥ `thresholdBp`.
 * Supports 2, 3, 4+ levels — NOT limited to 3%/4% (spec §5). */
export type PercentTier = { thresholdBp: number; percentBp: number };

/** Pick the highest tier whose threshold ≤ completion. Tiers may be unsorted; the
 * lowest-threshold tier is the floor when nothing else matches. */
export function pickPercentTier(completion: number, tiers: PercentTier[]): number {
  if (!tiers.length) return 0;
  const sorted = [...tiers].sort((a, b) => a.thresholdBp - b.thresholdBp);
  let chosen = sorted[0].percentBp;
  for (const t of sorted) if (completion >= t.thresholdBp) chosen = t.percentBp;
  return chosen;
}

const pct = (baseKopeks: number, percentBp: number) => Math.round((baseKopeks * percentBp) / BP);

// ============================ 1. Manager (управляющий) ========================
// АБ and ПТ are computed SEPARATELY by the SAME formula: completion → deviation from
// 100% → ×2 → clamp ±limit (default ±40%) → apply to that direction's base salary.

export type ManagerDirection = { baseKopeks: number; planKopeks: number; factKopeks: number };
export type ManagerDirectionResult = { completionBp: number; adjustmentBp: number; adjustedKopeks: number };

export function managerDirection(d: ManagerDirection, limitBp = 4000): ManagerDirectionResult {
  const comp = completionBp(d.planKopeks, d.factKopeks);
  const deviation = comp - BP; // >0 overperformance, <0 underperformance
  const adjustmentBp = clampBp(deviation * 2, -limitBp, limitBp);
  const adjustedKopeks = Math.round((d.baseKopeks * (BP + adjustmentBp)) / BP);
  return { completionBp: comp, adjustmentBp, adjustedKopeks };
}

export type ManagerInput = {
  ab: ManagerDirection; // абонементы
  pt: ManagerDirection; // персональные тренировки
  bonusesKopeks?: number;
  deductionsKopeks?: number;
  limitBp?: number; // default ±40%
};
export type ManagerResult = {
  ab: ManagerDirectionResult;
  pt: ManagerDirectionResult;
  bonusesKopeks: number;
  deductionsKopeks: number;
  totalKopeks: number;
};

export function managerSalary(inp: ManagerInput): ManagerResult {
  const limit = inp.limitBp ?? 4000;
  const ab = managerDirection(inp.ab, limit);
  const pt = managerDirection(inp.pt, limit);
  const bonuses = inp.bonusesKopeks ?? 0;
  const deductions = inp.deductionsKopeks ?? 0;
  return { ab, pt, bonusesKopeks: bonuses, deductionsKopeks: deductions, totalKopeks: ab.adjustedKopeks + pt.adjustedKopeks + bonuses - deductions };
}

// ============================ 2. Administrator ================================
// Ставка за смену × фактические смены. Норма по производственному календарю — только
// контроль (недоработка/переработка), НЕ участвует в формуле. Термин «оклад» не
// используется — это ставка за смену.

export type AdminInput = { shiftRateKopeks: number; shifts: number; normShifts?: number; bonusesKopeks?: number; deductionsKopeks?: number };
export type AdminResult = { salaryPartKopeks: number; normDeviationShifts: number; totalKopeks: number };

export function administratorSalary(inp: AdminInput): AdminResult {
  const salaryPart = Math.max(0, inp.shiftRateKopeks) * Math.max(0, inp.shifts);
  const bonuses = inp.bonusesKopeks ?? 0;
  const deductions = inp.deductionsKopeks ?? 0;
  return {
    salaryPartKopeks: salaryPart,
    normDeviationShifts: inp.normShifts != null ? inp.shifts - inp.normShifts : 0, // control only
    totalKopeks: salaryPart + bonuses - deductions,
  };
}

// ============================ 3. Sales manager ================================
// Оклад за 15 смен → стоимость смены = оклад/15; часть = стоимость × фактические смены
// (для <15 и >15 единообразно — каждая смена по стоимости смены). Процент — из ТИРОВ по
// выполнению ОБЩЕГО плана клуба (не личного). Процент применяется ко ВСЕЙ чистой личной
// выручке (личная − возвраты по его продажам).

export type SalesManagerInput = {
  salaryFor15Kopeks: number; // оклад за 15 смен
  shifts: number;
  clubPlanCompletionBp: number; // выполнение общего плана клуба, bp
  percentTiers: PercentTier[]; // напр. [{0,300},{10000,400}] — настраиваемо, 3–4+ уровней
  personalSalesKopeks: number;
  returnsKopeks?: number; // возвраты ПО ЕГО продажам
  bonusesKopeks?: number;
  deductionsKopeks?: number;
  shiftNorm?: number; // база смен для стоимости смены (default 15)
};
export type SalesManagerResult = {
  shiftValueKopeks: number;
  salaryPartKopeks: number;
  netPersonalSalesKopeks: number;
  appliedPercentBp: number;
  percentPartKopeks: number;
  totalKopeks: number;
};

export function salesManagerSalary(inp: SalesManagerInput): SalesManagerResult {
  const norm = inp.shiftNorm ?? 15;
  const shiftValue = norm > 0 ? Math.round(inp.salaryFor15Kopeks / norm) : 0;
  const salaryPart = shiftValue * Math.max(0, inp.shifts); // extra shifts paid at the same shift value
  const net = Math.max(0, inp.personalSalesKopeks - (inp.returnsKopeks ?? 0));
  const percentBp = pickPercentTier(inp.clubPlanCompletionBp, inp.percentTiers);
  const percentPart = pct(net, percentBp);
  const bonuses = inp.bonusesKopeks ?? 0;
  const deductions = inp.deductionsKopeks ?? 0;
  return { shiftValueKopeks: shiftValue, salaryPartKopeks: salaryPart, netPersonalSalesKopeks: net, appliedPercentBp: percentBp, percentPartKopeks: percentPart, totalKopeks: salaryPart + percentPart + bonuses - deductions };
}

// ============================ 4. Night manager ================================
// Ставка за ночную смену × смены + процент с чистой личной выручки (та же тир-система,
// что у менеджеров продаж). Нет 15-сменной базы, нормы, праздничных, доплат.

export type NightManagerInput = {
  shiftRateKopeks: number;
  shifts: number;
  clubPlanCompletionBp: number;
  percentTiers: PercentTier[];
  personalSalesKopeks: number;
  returnsKopeks?: number;
  bonusesKopeks?: number;
  deductionsKopeks?: number;
};
export type NightManagerResult = { salaryPartKopeks: number; netPersonalSalesKopeks: number; appliedPercentBp: number; percentPartKopeks: number; totalKopeks: number };

export function nightManagerSalary(inp: NightManagerInput): NightManagerResult {
  const salaryPart = Math.max(0, inp.shiftRateKopeks) * Math.max(0, inp.shifts);
  const net = Math.max(0, inp.personalSalesKopeks - (inp.returnsKopeks ?? 0));
  const percentBp = pickPercentTier(inp.clubPlanCompletionBp, inp.percentTiers);
  const percentPart = pct(net, percentBp);
  const bonuses = inp.bonusesKopeks ?? 0;
  const deductions = inp.deductionsKopeks ?? 0;
  return { salaryPartKopeks: salaryPart, netPersonalSalesKopeks: net, appliedPercentBp: percentBp, percentPartKopeks: percentPart, totalKopeks: salaryPart + percentPart + bonuses - deductions };
}

// ============================ 5. Gym trainer (ТЗ) =============================
// Новые клиенты % + продления %; настраиваемо. Зарплата ОТ ПРОДАЖ. Кредит тренера —
// информативный показатель, НЕ уменьшает начисление и НЕ блокирует выплату (spec §7).

export type GymTrainerInput = {
  newSalesKopeks: number;
  newRateBp: number; // напр. 4000 (40%) — настраиваемо
  renewalSalesKopeks: number;
  renewalRateBp: number; // напр. 5000 (50%)
  trainerCreditKopeks?: number; // информативно; НЕ вычитается
  bonusesKopeks?: number;
  deductionsKopeks?: number;
};
export type GymTrainerResult = { newPartKopeks: number; renewalPartKopeks: number; trainerCreditKopeks: number; totalKopeks: number };

export function gymTrainerSalary(inp: GymTrainerInput): GymTrainerResult {
  const newPart = pct(Math.max(0, inp.newSalesKopeks), inp.newRateBp);
  const renewalPart = pct(Math.max(0, inp.renewalSalesKopeks), inp.renewalRateBp);
  const bonuses = inp.bonusesKopeks ?? 0;
  const deductions = inp.deductionsKopeks ?? 0;
  // trainerCredit is informational — deliberately NOT part of totalKopeks.
  return { newPartKopeks: newPart, renewalPartKopeks: renewalPart, trainerCreditKopeks: inp.trainerCreditKopeks ?? 0, totalKopeks: newPart + renewalPart + bonuses - deductions };
}

// ============================ 6. Senior gym trainer (ТЗ) =====================
// Та же логика новых/продлений, но повышенный процент зависит от выполнения ОБЩЕГО
// плана ПТ клуба; повышенный процент применяется ко всей личной выручке. Нет фикс.
// оклада за руководство (spec §8). Проценты по тирам (настраиваемо).

export type SeniorGymTrainerInput = {
  newSalesKopeks: number;
  renewalSalesKopeks: number;
  clubPtCompletionBp: number; // выполнение общего плана ПТ клуба
  newTiers: PercentTier[];
  renewalTiers: PercentTier[];
  trainerCreditKopeks?: number;
  bonusesKopeks?: number;
  deductionsKopeks?: number;
};
export type SeniorGymTrainerResult = { appliedNewBp: number; appliedRenewalBp: number; newPartKopeks: number; renewalPartKopeks: number; trainerCreditKopeks: number; totalKopeks: number };

export function seniorGymTrainerSalary(inp: SeniorGymTrainerInput): SeniorGymTrainerResult {
  const newBp = pickPercentTier(inp.clubPtCompletionBp, inp.newTiers);
  const renewalBp = pickPercentTier(inp.clubPtCompletionBp, inp.renewalTiers);
  const newPart = pct(Math.max(0, inp.newSalesKopeks), newBp);
  const renewalPart = pct(Math.max(0, inp.renewalSalesKopeks), renewalBp);
  const bonuses = inp.bonusesKopeks ?? 0;
  const deductions = inp.deductionsKopeks ?? 0;
  return { appliedNewBp: newBp, appliedRenewalBp: renewalBp, newPartKopeks: newPart, renewalPartKopeks: renewalPart, trainerCreditKopeks: inp.trainerCreditKopeks ?? 0, totalKopeks: newPart + renewalPart + bonuses - deductions };
}

// ============================ 7. Group trainer (ГП) ==========================
// Часы × ставка за час + личные продажи × индивидуальный процент (настраиваемо).

export type GroupTrainerInput = { hours: number; hourRateKopeks: number; personalSalesKopeks: number; personalRateBp: number; bonusesKopeks?: number; deductionsKopeks?: number };
export type GroupTrainerResult = { hoursPartKopeks: number; personalPartKopeks: number; totalKopeks: number };

export function groupTrainerSalary(inp: GroupTrainerInput): GroupTrainerResult {
  const hoursPart = Math.max(0, inp.hours) * Math.max(0, inp.hourRateKopeks);
  const personalPart = pct(Math.max(0, inp.personalSalesKopeks), inp.personalRateBp);
  const bonuses = inp.bonusesKopeks ?? 0;
  const deductions = inp.deductionsKopeks ?? 0;
  return { hoursPartKopeks: hoursPart, personalPartKopeks: personalPart, totalKopeks: hoursPart + personalPart + bonuses - deductions };
}

// ============================ 8. Senior group trainer (ГП) ===================
// Часы × ставка + личный процент + фикс. доплата старшего (по умолч. 5000₽) + доля от
// ВСЕЙ выручки ГП клуба (по умолч. 10%, после возвратов). Всё настраиваемо (spec §10).

export type SeniorGroupTrainerInput = {
  hours: number;
  hourRateKopeks: number;
  personalSalesKopeks: number;
  personalRateBp: number;
  fixedBonusKopeks?: number; // default 500000 (5000₽)
  clubGroupSalesKopeks: number; // вся выручка ГП клуба (после возвратов)
  clubShareBp?: number; // default 1000 (10%)
  bonusesKopeks?: number;
  deductionsKopeks?: number;
};
export type SeniorGroupTrainerResult = { hoursPartKopeks: number; personalPartKopeks: number; fixedBonusKopeks: number; clubSharePartKopeks: number; totalKopeks: number };

export function seniorGroupTrainerSalary(inp: SeniorGroupTrainerInput): SeniorGroupTrainerResult {
  const hoursPart = Math.max(0, inp.hours) * Math.max(0, inp.hourRateKopeks);
  const personalPart = pct(Math.max(0, inp.personalSalesKopeks), inp.personalRateBp);
  const fixedBonus = inp.fixedBonusKopeks ?? 500000;
  const clubShare = pct(Math.max(0, inp.clubGroupSalesKopeks), inp.clubShareBp ?? 1000);
  const bonuses = inp.bonusesKopeks ?? 0;
  const deductions = inp.deductionsKopeks ?? 0;
  return { hoursPartKopeks: hoursPart, personalPartKopeks: personalPart, fixedBonusKopeks: fixedBonus, clubSharePartKopeks: clubShare, totalKopeks: hoursPart + personalPart + fixedBonus + clubShare + bonuses - deductions };
}

// ============================ Category classification =========================
// Map a position to one of the 5 manager-facing cards (spec §2). The «Аванс» card is
// cross-category (all active employees), handled by the advance contour, not here.

export type PayrollCategory = "manager" | "admin" | "gym_trainer" | "group_trainer";
export type AdminSubcategory = "sales_manager" | "administrator" | "night_manager";

export function categoryOfPosition(position: string): PayrollCategory | null {
  switch (position) {
    case "manager":
      return "manager";
    case "sales_manager":
    case "administrator":
    case "night_manager":
      return "admin";
    case "head_gym_trainer":
    case "gym_trainer":
      return "gym_trainer";
    case "senior_group_trainer":
    case "group_trainer":
      return "group_trainer";
    default:
      return null;
  }
}

export const CATEGORY_LABELS: Record<PayrollCategory, string> = {
  manager: "Управляющий",
  admin: "Административный состав",
  gym_trainer: "Тренеры ТЗ",
  group_trainer: "Тренеры ГП",
};
