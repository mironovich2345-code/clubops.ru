# Invoice payments — partial / post-factum / AI quality — pre-change audit

Read-only survey before adding partial payments, multiple payments, post-factum entry, reversal, and
AI quality. **The regular invoice approval route and all out-of-scope calculations stay unchanged.**

## Current payment model
- `Invoice`: `amountKopeks` (total), `paidAt DateTime?`, `status` (draft | needs_review |
  needs_correction | approved_by_regional | approved_by_owner | paid | rejected | canceled),
  `expensePeriod` ("YYYY-MM", accrual month), `confidence`, AI review fields (`aiDataReviewedAt/ById`,
  `approvedDataFingerprint`), `counterparty*` + `payer*`, `clientSubmissionId` (unique idempotency).
- **Payment is BINARY today:** `transitionInvoice` moves approved → `paid` and stamps `paidAt`. There
  is **no** partial amount, no per-payment record, no `paidById`/`paidAmount`/`paymentDate` field.
- **Post-factum entry already exists:** `saveHistoricalInvoice` («Добавить оплаченный счёт») creates a
  `paid` invoice directly (accountant/chief only, `canAddPaidInvoice`); it does not model a payment row.

## Financial reflection (the double-count boundary — critical)
- Invoices reflect in **expenses / budgets / analytics by `expensePeriod` (accrual)**, NOT by payment
  date. The full `amountKopeks` counts once when the invoice is approved/paid. Comment in the model:
  "Expense belongs to its period; money may leave in a different month."
- The **payments calendar** (`payment-obligations.ts`) treats an unpaid approved invoice as an
  obligation due (by `dueDate`); a `paid` invoice is not due.
- **No-double-count rule:** `InvoicePayment` is a NEW parallel ledger for the *cash-payment* fact
  (status + remaining + payment date). Analytics/budgets keep reading `Invoice.amountKopeks` by
  `expensePeriod` and must NOT also read `InvoicePayment` — otherwise the amount would count twice.
  Payments are capped at the invoice total, so the payment sum never exceeds the accrued expense.
  The **only** consumer that must change: the payments-calendar obligation for a `partially_paid`
  invoice becomes `remainingTotal` (invoiceTotal − paidTotal), not the full amount.

## Partial-payment risks / where double-count could arise
- If analytics summed `InvoicePayment` in addition to `Invoice` → double count. Mitigation: analytics
  untouched; payments are a separate ledger.
- If the obligation kept the full amount for a partially_paid invoice → the paid part would still show
  as due. Mitigation: obligation = remaining.
- Overpayment (`paidTotal > total`) → refused by default (future scenario, not implemented now).

## Roles that actually exist
`owner`, `general_director`, `regional_director`, `manager`, `chief_accountant`, `accountant`,
`marketer`, `system_admin`. `chief_accountant` **exists** and implies `accountant`
(`ROLE_IMPLICATIONS.chief_accountant = ["accountant"]`) with its own capability set. → **Reversal**
can be a new capability `invoice.payment.reverse` granted to **chief_accountant only** — no new role
or migration needed for the role itself; accountant/owner/GD do not get it.

## Legacy cancel of paid invoices (to block — §8)
`cancelInvoice` currently allows `INVOICE_CANCELABLE = [draft, needs_review, approved_by_regional,
approved_by_owner, paid]`; only a *manager-only* actor is blocked from cancelling a `paid` invoice —
an accountant/regional CAN. **Change:** remove `paid` (and never allow `partially_paid`) from
cancelable statuses; a paid/partially_paid invoice can only be adjusted by **reversing a specific
payment** (chief accountant). No hard delete of invoices/payments.

## AI pipeline
- `invoice-analyzer.ts` (LLM extraction → `counterpartyName/Inn`, `payerName/Inn`, `amount`, …) +
  `invoice-party.ts` (`normalizeName`, `resolveCounterparty`, `comparePayer`). §14-16 improvements:
  supplier extraction (not payer/address/bank/signer), payer match primarily by INN within company
  scope, final-payable-amount (not VAT/subtotal/advance), with warnings + evidence + review reset on
  file/amount/INN/account change.

## Migration needed?
- **Yes (additive):** new `InvoicePayment` table. **No** change to `Invoice` columns is strictly
  required (status gains `partially_paid` as a string value; `enteredAfterPayment`/`legacyBackfill`
  live on `InvoicePayment`). Optionally add AI-review timestamps already present. Reversal uses a new
  **capability** (no schema change). All additive, non-destructive; dev sqlite + prod postgres.

## Backward compatibility
- Existing `paid` invoices: a one-time **backfill** creates ONE `legacy_backfill` payment for the full
  amount (`paymentDate = paidAt`, `createdById = paidById?/creator`, `legacyBackfill = true`,
  idempotencyKey) so `paidTotal = total` and status stays `paid` — no analytics recompute, no double
  count, idempotent. Unpaid invoices get no payment. Legacy `approved`/`paid` transitions untouched.

## Stays unchanged (out of scope)
Regular approval route; manager/regional rights outside invoices; tenant isolation; multi-account;
expenses; refunds; payroll; cash formulas; budgets; analytics formulas outside invoice payment.
