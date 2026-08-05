# CLUB-OPS — Invoice Recognition & Payment (accounting note)

## Recognition (REM-05, unchanged)
The FULL recognized invoice amount is an EXPENSE by `expensePeriod` once the invoice is approved
(approved-unpaid + `partially_paid` + `paid`). It flows into profit and budget fact at full amount and is
**independent of payment** — partial payments, full payment, and reversals do NOT change the recognized
amount. See `profit-formulas.md` / `budget-fact-model.md`.

## Payment fact (REM-08)
The **InvoicePayment ledger** is the single source of payment fact:
- `paidTotal = Σ confirmed payments` (reversed rows drop out); `remaining = max(total − paidTotal, 0)`.
- Payment state: unpaid / `partially_paid` (0<paid<total) / `paid` (paid≥total). `Invoice.status` is a
  stored reflection, synced only inside the payment/reversal transaction (`derivedInvoiceStatus`); it is
  never the source of `paidTotal`.
- `paidAt` is set only when fully paid (null while partial/unpaid); it is a compatibility field, not
  history.
- Payment/reversal go through ONE service (`applyInvoicePaymentInTx` / `applyInvoicePaymentReversalInTx`),
  idempotent (`idempotencyKey @unique`), atomic, append-only for reversal.

## Retired: legacy binary pay
The old `transitionInvoice(action="pay")` that flipped `status="paid"` without a ledger row is **retired**
(ARCH-010/DATA-005/FIN-006). Status can reach `paid` ONLY via a confirmed payment. Historical ledgerless
paid invoices stay recognized as expense but carry a `legacy_ledger_missing` warning
(`reconcile:invoice-payments`) and are reconciled MANUALLY (never auto-repaired) —
`docs/remediation/rem-08-legacy-ledgerless-plan.md`.

Proven by `test:rem-08-invoice-ledger` (15/15) + `pilot:rem-08-invoice-payment-ledger`. Production
concurrency + historical reconciliation are the live gates (G-INVLEDGER-8/9/10). See
`docs/remediation/rem-08-final-report.md`.
