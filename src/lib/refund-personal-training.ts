// Personal-training refund calculation (Refund v2, returnType=personal_training)
// — Phase 2B. Pure + server-safe; the single source of truth, mirrored by tests.
// Reuses the Phase-2A date-only + planned-date + ceil-to-ruble helpers (no
// duplicated date/money logic). Integer kopeks via BigInt; the per-session price
// is never rounded before the final result.
import { ceilToRubleKopeks, computePlannedRefundDate, type DateOnly, type PlannedDate } from "@/lib/refund-membership";

export const PT_METHODS = ["contract_rate", "average_rate"] as const;
export type PtMethod = (typeof PT_METHODS)[number];
export function isPtMethod(v: string): v is PtMethod {
  return (PT_METHODS as readonly string[]).includes(v);
}
export const PT_METHOD_LABELS: Record<PtMethod, string> = {
  contract_rate: "Согласно условиям договора",
  average_rate: "По средней стоимости тренировки",
};

export const PT_CALC_VERSION = {
  contract_rate: "pt_contract_rate_v1",
  average_rate: "pt_average_rate_v1",
  not_provided: "pt_not_provided_v1",
} as const;

export const PT_MIN_REASON_LEN = 10;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b; // a>=0, b>0

export type PtInput = {
  contractAmountKopeks: number; // X
  contractSessions: number; // N
  usedSessions: number; // E
  terminationPriceKopeks: number; // V
  method: PtMethod;
  serviceNotProvided: boolean;
  application: DateOnly; // O (future-date check done by caller)
};

export type PtResult =
  | { ok: false; error: string }
  | {
      ok: true;
      mode: "not_provided" | "contract_rate" | "average_rate";
      calculationVersion: string;
      unavailable: boolean; // true only for a negative contract-rate result
      rawResultKopeks: number; // SIGNED pre-round result (may be < 0 for contract_rate)
      usedAmountKopeks: number; // informational: V×E, or avg×E for average_rate
      resultAmountKopeks: number | null; // final, ceil-to-ruble; null when unavailable
      zeroRemaining: boolean;
      base: DateOnly;
      planned: DateOnly;
      adjustmentReason: string | null;
      refusalDraftText: string | null;
      unavailableReason: string | null;
    };

export function computePersonalTrainingRefund(input: PtInput): PtResult {
  const { contractAmountKopeks: X, contractSessions: N, usedSessions: Eraw, terminationPriceKopeks: V, method, serviceNotProvided } = input;
  if (!Number.isInteger(X) || X <= 0) return { ok: false, error: "Сумма договора должна быть больше нуля." };
  if (!Number.isInteger(N) || N <= 0) return { ok: false, error: "Количество тренировок по договору должно быть целым числом больше нуля." };
  if (!Number.isInteger(Eraw) || Eraw < 0) return { ok: false, error: "Количество проведённых тренировок должно быть целым неотрицательным числом." };
  if (!Number.isInteger(V) || V <= 0) return { ok: false, error: "Стоимость тренировки при расторжении должна быть больше нуля." };
  // Service-not-provided normalizes E to 0 (client value is not trusted).
  const E = serviceNotProvided ? 0 : Eraw;
  if (E > N) return { ok: false, error: "Количество проведённых тренировок не может превышать количество тренировок по договору." };
  if (!serviceNotProvided && !isPtMethod(method)) return { ok: false, error: "Неверный способ расчёта." };

  const { base, planned, adjustmentReason } = computePlannedRefundDate(input.application);

  // Full refund — service not provided.
  if (serviceNotProvided) {
    return {
      ok: true, mode: "not_provided", calculationVersion: PT_CALC_VERSION.not_provided, unavailable: false,
      rawResultKopeks: X, usedAmountKopeks: 0, resultAmountKopeks: ceilToRubleKopeks(X), zeroRemaining: false,
      base, planned, adjustmentReason, refusalDraftText: null, unavailableReason: null,
    };
  }

  if (method === "contract_rate") {
    // R1 = X − V×E (exact integer kopeks; may be negative).
    const raw = X - V * E;
    if (raw < 0) {
      return {
        ok: true, mode: "contract_rate", calculationVersion: PT_CALC_VERSION.contract_rate, unavailable: true,
        rawResultKopeks: raw, usedAmountKopeks: V * E, resultAmountKopeks: null, zeroRemaining: false,
        base, planned, adjustmentReason,
        refusalDraftText: buildRefusalDraft(X, V, E, raw),
        unavailableReason: "Стоимость использованных тренировок превышает сумму договора; сумма к возврату отсутствует.",
      };
    }
    return {
      ok: true, mode: "contract_rate", calculationVersion: PT_CALC_VERSION.contract_rate, unavailable: false,
      rawResultKopeks: raw, usedAmountKopeks: V * E, resultAmountKopeks: ceilToRubleKopeks(raw), zeroRemaining: raw === 0,
      base, planned, adjustmentReason, refusalDraftText: null, unavailableReason: null,
    };
  }

  // average_rate: R2 = X × (N − E) / N (never round X/N first). E<=N ⇒ ≥ 0.
  const remaining = N - E;
  const numerator = BigInt(X) * BigInt(remaining);
  const rubles = numerator === 0n ? 0n : ceilDiv(numerator, BigInt(N) * 100n);
  const resultAmountKopeks = Number(rubles * 100n);
  const rawResultKopeks = Number(numerator / BigInt(N)); // floor kopeks, informational pre-round
  const usedAmountKopeks = X - rawResultKopeks; // informational (avg × E ≈)
  return {
    ok: true, mode: "average_rate", calculationVersion: PT_CALC_VERSION.average_rate, unavailable: false,
    rawResultKopeks, usedAmountKopeks, resultAmountKopeks, zeroRemaining: remaining === 0,
    base, planned, adjustmentReason, refusalDraftText: null, unavailableReason: null,
  };
}

const rub = (k: number) => (k / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Neutral, reproducible refusal draft for a negative contract-rate result. */
export function buildRefusalDraft(X: number, V: number, E: number, rawKopeks: number): string {
  return (
    "По результатам расчёта стоимость использованных персональных тренировок превышает сумму договора. " +
    "Сумма к возврату отсутствует. Расчёт: сумма договора − стоимость одной тренировки при расторжении × количество проведённых тренировок. " +
    `Сумма договора: ${rub(X)} ₽; стоимость тренировки при расторжении: ${rub(V)} ₽; проведено тренировок: ${E}; результат расчёта: ${rub(rawKopeks)} ₽. ` +
    "Проект ответа требует проверки сотрудником перед отправкой клиенту."
  );
}

export type { PlannedDate };
