// Pure aggregates + status derivation for the InvoicePayment ledger. Integer kopeks only —
// no JS float. This is a CASH-payment ledger; analytics/budgets keep reflecting the invoice
// by its expensePeriod (accrual) and never read this table (no double count). Server-safe.

export const INVOICE_PAYMENT_SOURCES = ["bank", "edo", "cash", "other", "legacy_backfill"] as const;
export type InvoicePaymentSource = (typeof INVOICE_PAYMENT_SOURCES)[number];

// A paid/partially_paid invoice can no longer use the legacy cancel path — only a
// specific payment reversal (chief accountant) adjusts it (§8).
export const PAYMENT_LOCKED_STATUSES: readonly string[] = ["paid", "partially_paid"];

export type InvoicePaymentLike = { status: string; amountKopeks: number };

/** paidTotal = Σ confirmed payments (reversed payments leave the confirmed set). */
export function paidTotalKopeks(payments: InvoicePaymentLike[]): number {
  return payments.filter((p) => p.status === "confirmed").reduce((a, p) => a + (p.amountKopeks || 0), 0);
}

/** remaining = invoiceTotal − paidTotal (never negative for a valid ledger). */
export function remainingKopeks(invoiceTotalKopeks: number, payments: InvoicePaymentLike[]): number {
  return invoiceTotalKopeks - paidTotalKopeks(payments);
}

/**
 * Derived invoice status from the payment total — the accountant never picks the final
 * status directly (§4). 0 paid → the pre-payment approved state (restored on full reversal);
 * 0 < paid < total → partially_paid; paid ≥ total → paid.
 */
export function derivedInvoiceStatus(paid: number, invoiceTotalKopeks: number, prePaymentStatus: string | null, currentStatus: string): string {
  if (invoiceTotalKopeks > 0 && paid >= invoiceTotalKopeks) return "paid";
  if (paid > 0) return "partially_paid";
  return prePaymentStatus ?? currentStatus; // fully reversed / no payment → restore exactly
}

export type PaymentAmountError = "not_positive" | "over_remaining" | "no_remaining" | null;

/** Validate a proposed payment amount against the remaining. Full payment must equal the
 *  remaining; partial must be 0 < amount ≤ remaining. Overpayment is refused (§3). */
export function validatePaymentAmount(amountKopeks: number, remaining: number, mode: "full" | "partial"): PaymentAmountError {
  if (remaining <= 0) return "no_remaining";
  if (mode === "full") return amountKopeks === remaining ? null : "over_remaining";
  if (!Number.isInteger(amountKopeks) || amountKopeks <= 0) return "not_positive";
  if (amountKopeks > remaining) return "over_remaining";
  return null;
}
