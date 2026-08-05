# REM-08 — Invoice Payment-Ledger Baseline

Read-only assessment before any REM-08 change. Money = kopeks.

## Git baseline
| Aspect | Value |
|---|---|
| HEAD | `176a256` |
| tsc | 0 · prisma dev/prod valid · pilot:full 4095/0 (REM-05A) · build:prod compiles |

## As-is (the InvoicePayment ledger already exists — from the partial-payment epic)
- `InvoicePayment` model: amount, paymentDate, source, status(confirmed|reversed), reversal fields,
  `idempotencyKey @unique`, `enteredAfterPayment`, `legacyBackfill`.
- `src/lib/invoice-payments.ts` (pure): `paidTotalKopeks` (confirmed only), `remainingKopeks`,
  `derivedInvoiceStatus` (unpaid → partially_paid → paid), `validatePaymentAmount`.
- `recordInvoicePayment` (ledger create + status sync in `$transaction`, idempotency via @unique),
  `reverseInvoicePayment` (append-only confirmed→reversed + re-sync), `saveHistoricalInvoice` (post-factum:
  invoice + payment atomically). `InvoicePaymentPanel` UI → these ledger actions.

## The defect (ARCH-010 / DATA-005 / FIN-006)
- `transitionInvoice(action="pay")` flipped `Invoice.status="paid"` + `paidAt` via a bare `updateMany`
  WITHOUT creating an InvoicePayment → a paid invoice with `paidTotal=0` (ledgerless). Reachable from the
  edit form's `availableInvoiceActions` "pay" button. This is the legacy binary pay.
- Recognition (REM-05) already counts the FULL invoice amount regardless of payments, so a ledgerless
  paid invoice is still a correct EXPENSE — but it misrepresents "how much was actually paid".

## Payment-fact readers (as-is)
`paidTotalKopeks`/`remainingKopeks` read the ledger (confirmed − reversed); the payment panel + calendar
use them. `Invoice.status` is a stored reflection, synced only inside the payment transaction.

## Findings in scope
- **ARCH-010** — legacy pay marks paid without a ledger row.
- **DATA-005** — paid invoice can exist without a payment ledger.
- **FIN-006** — ledgerless paid invoice recognized as expense with `paidTotal=0`.
- **FIN-002** — CLOSED from REM-05 (partially_paid in profit/budget); status/ledger semantics to formalize.

## Approach
Retire the legacy binary pay (block the transition + drop the button); route ALL payment/reversal writes
through ONE service (`applyInvoicePaymentInTx`/`applyInvoicePaymentReversalInTx`); `partially_paid` = stored
status SYNCED from the ledger inside the tx (strategy B). Preflight + reconcile for legacy ledgerless rows
(never auto-repaired). No recognized-expense/profit/budget change; no production data change.
