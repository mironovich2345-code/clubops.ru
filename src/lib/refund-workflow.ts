// Refund v2 review workflow (Phase 3A) — pure, server-safe status model +
// submission-readiness + comment validation. Legacy approval (lib/approval) is
// untouched; these v2 statuses are distinct and only apply to entryVersion=2.
import { isRefundDocumentSetComplete, validateRefundRequisites } from "@/lib/refund-documents";

export const REFUND_V2_STATUS = {
  DRAFT: "draft",
  PENDING_REGIONAL_REVIEW: "pending_regional_review",
  NEEDS_CORRECTION: "needs_correction",
  ACCOUNTING_IN_PROGRESS: "accounting_in_progress",
} as const;

export const REFUND_V2_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик",
  pending_regional_review: "На проверке у регионального директора",
  needs_correction: "Требует исправления",
  accounting_in_progress: "В работе у бухгалтера",
};

/** Statuses in which the manager (author) may edit a v2 refund. */
export function isRefundV2Editable(status: string): boolean {
  return status === REFUND_V2_STATUS.DRAFT || status === REFUND_V2_STATUS.NEEDS_CORRECTION;
}

export const REFUND_CORRECTION_MIN = 5;

export function validateCorrectionComment(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = String(raw ?? "").trim();
  if (value.length < REFUND_CORRECTION_MIN) return { ok: false, error: "Комментарий об исправлении обязателен." };
  return { ok: true, value: value.slice(0, 2000) };
}

// Minimal shape needed to judge submission readiness.
export type RefundReadinessInput = {
  entryVersion: number;
  returnType: string | null;
  calculationVersion: string | null;
  amountKopeks: number;
  refundResultAmountKopeks: number | null;
  ptRefundUnavailableReason: string | null;
  bankRecipientName: string | null;
  bankName: string | null;
  bankBik: string | null;
  bankAccount: string | null;
  bankCorrAccount: string | null;
};

/**
 * Everything that must hold before a manager may send a v2 refund to regional
 * review: v2, known type, complete documents, valid requisites, finished
 * calculation, a strictly positive result, and no blocking (negative) PT result.
 */
export function refundSubmissionReadiness(refund: RefundReadinessInput, activeDocTypes: readonly string[]): { ok: true } | { ok: false; error: string } {
  if (refund.entryVersion !== 2) return { ok: false, error: "Возврат недоступен для отправки." };
  if (refund.returnType !== "membership" && refund.returnType !== "personal_training") return { ok: false, error: "Не выбран тип возврата." };
  if (!isRefundDocumentSetComplete(refund.returnType, activeDocTypes)) return { ok: false, error: "Загружены не все обязательные документы." };
  if (!validateRefundRequisites(refund).ok) return { ok: false, error: "Банковские реквизиты заполнены не полностью." };
  if (!refund.calculationVersion) return { ok: false, error: "Расчёт возврата не завершён." };
  if (refund.ptRefundUnavailableReason) return { ok: false, error: "Возврат не принимается — отрицательный результат нельзя отправить." };
  if (refund.refundResultAmountKopeks == null || refund.refundResultAmountKopeks <= 0 || refund.amountKopeks <= 0) {
    return { ok: false, error: "Сумма возврата равна 0 ₽. Такой возврат нельзя отправить на согласование." };
  }
  return { ok: true };
}
