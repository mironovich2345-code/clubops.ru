// Регионал — единый расчёт по городу (spec item 4). Одно начисление на город+месяц;
// выплаты частями из клубов города; переплата запрещена без явного долга. Чистые функции.
import { ceilToRubleKopeks } from "@/lib/refund-membership";
import { BP_PER_100_PERCENT } from "@/lib/payroll/enums";

export const REGIONAL_BASE_TYPES = ["revenue", "profit"] as const;
export type RegionalBaseType = (typeof REGIONAL_BASE_TYPES)[number];
export const REGIONAL_BASE_LABELS: Record<string, string> = { revenue: "Выручка города", profit: "Чистая прибыль города" };

/** Начисление = база × % (округление до рубля). */
export function regionalAccrual(baseKopeks: number, percentBp: number): number {
  return ceilToRubleKopeks(Math.round((Math.max(0, baseKopeks) * Math.max(0, percentBp)) / BP_PER_100_PERCENT));
}

export type RegionalTotals = { paidKopeks: number; remainingKopeks: number; overpayKopeks: number };

/** Итоги по выплатам: сумма из клубов, остаток, переплата (если выплачено сверх начисления). */
export function regionalTotals(accruedKopeks: number, payments: { amountKopeks: number }[]): RegionalTotals {
  const paid = payments.reduce((s, p) => s + p.amountKopeks, 0);
  const remaining = accruedKopeks - paid;
  return { paidKopeks: paid, remainingKopeks: remaining, overpayKopeks: remaining < 0 ? -remaining : 0 };
}

/** Разбивка выплат по клубам-источникам (клуб A / клуб B / …). */
export function paidByClub(payments: { clubId: string; amountKopeks: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of payments) m.set(p.clubId, (m.get(p.clubId) ?? 0) + p.amountKopeks);
  return m;
}
