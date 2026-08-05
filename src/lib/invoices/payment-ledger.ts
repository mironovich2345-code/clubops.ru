// REM-08 — the SINGLE invoice-payment ledger service (spec §3/§4/§8). Every live
// payment/reversal write goes through here, inside the caller's transaction, so the
// InvoicePayment ledger is the ONE source of payment fact and Invoice.status is a
// SYNCED reflection of it (never the source of paidTotal). No bare status="paid" flip
// exists outside this service (that legacy path is retired — ARCH-010/DATA-005).
//
// Accounting model (unchanged from the ratified partial-payment epic):
//   paidTotal = Σ confirmed InvoicePayment.amount (reversed rows drop out)
//   remaining = max(invoice.amount − paidTotal, 0)
//   status: unpaid(<pre-payment approved) · partially_paid(0<paid<total) · paid(paid≥total)
// The FULL recognized invoice expense is independent of payment (REM-05) — this
// service NEVER touches expense/profit/budget.

import type { DbClient } from "@/lib/db-client";
import { paidTotalKopeks, derivedInvoiceStatus } from "@/lib/invoice-payments";
import { INVOICE_APPROVED_UNPAID_STATUSES } from "@/lib/invoices";

export type LedgerInvoice = {
  id: string;
  companyId: string;
  amountKopeks: number;
  status: string;
  prePaymentStatus: string | null;
  paidAt: Date | null;
};

export type ApplyPaymentInput = {
  invoice: LedgerInvoice;
  amountKopeks: number;
  paymentDate: Date;
  source: string;
  method?: string | null;
  comment?: string | null;
  proofDocumentId?: string | null;
  createdById: string;
  idempotencyKey: string;
  enteredAfterPayment?: boolean;
  legacyBackfill?: boolean;
};

/**
 * Create ONE confirmed InvoicePayment and SYNC the invoice status/paidAt from the
 * ledger — inside the caller's `tx`. Captures the pre-payment approved status once so
 * a full reversal restores it exactly. Returns the recomputed totals. Idempotency is
 * enforced by the InvoicePayment.idempotencyKey @unique (the caller catches P2002 as
 * a benign replay). NEVER writes expense/profit/budget.
 */
export async function applyInvoicePaymentInTx(tx: DbClient, input: ApplyPaymentInput): Promise<{ newPaidKopeks: number; nextStatus: string; paidAt: Date | null }> {
  const inv = input.invoice;
  // Capture the pre-payment approved state once (exact restore on full reversal).
  if (!inv.prePaymentStatus && (INVOICE_APPROVED_UNPAID_STATUSES as readonly string[]).includes(inv.status)) {
    await tx.invoice.update({ where: { id: inv.id }, data: { prePaymentStatus: inv.status } });
  }
  await tx.invoicePayment.create({
    data: {
      companyId: inv.companyId,
      invoiceId: inv.id,
      amountKopeks: input.amountKopeks,
      paymentDate: input.paymentDate,
      source: input.source,
      method: input.method ?? null,
      comment: input.comment ?? null,
      proofDocumentId: input.proofDocumentId ?? null,
      createdById: input.createdById,
      status: "confirmed",
      idempotencyKey: input.idempotencyKey,
      enteredAfterPayment: input.enteredAfterPayment ?? false,
      legacyBackfill: input.legacyBackfill ?? false,
    },
  });
  const fresh = await tx.invoicePayment.findMany({ where: { invoiceId: inv.id }, select: { status: true, amountKopeks: true } });
  const newPaidKopeks = paidTotalKopeks(fresh);
  const pre = inv.prePaymentStatus ?? ((INVOICE_APPROVED_UNPAID_STATUSES as readonly string[]).includes(inv.status) ? inv.status : null);
  const nextStatus = derivedInvoiceStatus(newPaidKopeks, inv.amountKopeks, pre, inv.status);
  const paidAt = newPaidKopeks >= inv.amountKopeks && inv.amountKopeks > 0 ? input.paymentDate : null;
  await tx.invoice.update({ where: { id: inv.id }, data: { status: nextStatus, paidAt } });
  return { newPaidKopeks, nextStatus, paidAt };
}

/**
 * Reverse ONE confirmed payment (append-only: the row is flipped to `reversed`, never
 * deleted) and re-sync the invoice status/paidAt from the ledger — inside `tx`.
 * Returns ok=false if the payment was not in a confirmed state (double-reversal guard).
 */
export async function applyInvoicePaymentReversalInTx(
  tx: DbClient,
  input: { invoice: LedgerInvoice; paymentId: string; reversedById: string; reason: string },
): Promise<{ ok: boolean; newPaidKopeks: number; nextStatus: string }> {
  const inv = input.invoice;
  const n = await tx.invoicePayment.updateMany({
    where: { id: input.paymentId, status: "confirmed" },
    data: { status: "reversed", reversedById: input.reversedById, reversedAt: new Date(), reversalReason: input.reason.slice(0, 500) },
  });
  if (n.count !== 1) return { ok: false, newPaidKopeks: 0, nextStatus: inv.status };
  const fresh = await tx.invoicePayment.findMany({ where: { invoiceId: inv.id }, select: { status: true, amountKopeks: true } });
  const newPaidKopeks = paidTotalKopeks(fresh);
  const nextStatus = derivedInvoiceStatus(newPaidKopeks, inv.amountKopeks, inv.prePaymentStatus, inv.status);
  const paidAt = newPaidKopeks >= inv.amountKopeks && inv.amountKopeks > 0 ? inv.paidAt : null;
  await tx.invoice.update({ where: { id: inv.id }, data: { status: nextStatus, paidAt } });
  return { ok: true, newPaidKopeks, nextStatus };
}
