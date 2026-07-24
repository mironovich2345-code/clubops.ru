// Тренер ТЗ (spec §4.2) — сводка по пакетам для карточки расчёта и финального расчёта.
// Держит РАЗДЕЛЬНО: (1) начисление по пакетам (40/50%/индивидуальная ставка, за вычетом
// возвратов) + порог 70% плана продаж — это ГЕЙТ выплаты; (2) кредит тренера = оплачено
// vs проведено занятий (переиспользует calcTrainerCredit). Чистые функции, без БД.
import type { PayrollTrainerPackage } from "@prisma/client";
import { calcGymPackage, calcTrainerCredit, type GymPackage } from "@/lib/payroll/calc";
import type { GymTrainerParams } from "@/lib/payroll/scheme";

/** Stored package → engine GymPackage (carries the custom rate + net-of-refund contract). */
export function toGymPackage(p: Pick<PayrollTrainerPackage, "contractAmountKopeks" | "sessionCount" | "refundKopeks" | "trainerRateBp">): GymPackage {
  return { contractAmountKopeks: p.contractAmountKopeks, sessionCount: p.sessionCount, refundKopeks: p.refundKopeks, rateBp: p.trainerRateBp ?? null };
}

export type TrainerSummary = {
  soldPackages: number;
  salesTotalKopeks: number; // Σ contract amount
  refundsTotalKopeks: number; // Σ refund
  accrualKopeks: number; // Σ trainer income (начисление)
  totalSessions: number;
  providedSessions: number;
  providedValueKopeks: number; // trainer value of provided sessions
  allowedPayoutKopeks: number; // = providedValue — сколько допустимо выплатить сейчас
  creditKopeks: number; // накопленный кредит тренера (начислено сверх проведённого)
};

type PkgLike = Pick<PayrollTrainerPackage, "contractAmountKopeks" | "sessionCount" | "refundKopeks" | "trainerRateBp" | "providedSessions">;

/**
 * Aggregate the trainer's packages. `accrual` is the per-package income; `credit` is the
 * paid-vs-provided gap (via calcTrainerCredit per package). These are INDEPENDENT of the
 * 70% plan gate (which only holds/releases the payout, handled in calcGymTrainer).
 */
export function computeTrainerSummary(params: GymTrainerParams, pkgs: PkgLike[]): TrainerSummary {
  let salesTotal = 0, refundsTotal = 0, accrual = 0, totalSessions = 0, providedSessions = 0, providedValue = 0, credit = 0;
  for (const p of pkgs) {
    const income = calcGymPackage(params, toGymPackage(p)).incomeKopeks;
    const perSession = p.sessionCount > 0 ? Math.round(income / p.sessionCount) : 0;
    const cr = calcTrainerCredit({ paidSessions: p.sessionCount, providedSessions: p.providedSessions, sessionPriceKopeks: perSession });
    salesTotal += p.contractAmountKopeks;
    refundsTotal += p.refundKopeks;
    accrual += income;
    totalSessions += p.sessionCount;
    providedSessions += Math.min(p.providedSessions, p.sessionCount);
    providedValue += cr.providedValueKopeks;
    credit += cr.overpaidKopeks;
  }
  return {
    soldPackages: pkgs.length,
    salesTotalKopeks: salesTotal,
    refundsTotalKopeks: refundsTotal,
    accrualKopeks: accrual,
    totalSessions,
    providedSessions,
    providedValueKopeks: providedValue,
    allowedPayoutKopeks: providedValue,
    creditKopeks: credit,
  };
}
