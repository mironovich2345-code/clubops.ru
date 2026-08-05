# REM-08 — Invoice Payment Write-Path Map

Every path that can set a payment/`paid` state, before → after.

| Path | Role | Creates InvoicePayment? | Status write | Idempotent | Atomic | After REM-08 |
|---|---|---|---|---|---|---|
| `recordInvoicePayment` | accountant/chief | ✅ (confirmed) | derived (synced) | ✅ @unique | ✅ `$transaction` | delegates to `applyInvoicePaymentInTx` |
| `reverseInvoicePayment` | chief | flips to reversed (append-only) | derived (synced) | guard `count!==1` | ✅ | delegates to `applyInvoicePaymentReversalInTx` |
| `saveHistoricalInvoice` (post-factum) | accountant | ✅ (`enteredAfterPayment`) | paid + ledger row | key on the row | ✅ | unchanged (already ledger-backed) |
| **`transitionInvoice(action="pay")`** | accountant | ❌ **bare `status="paid"` flip** | ❌ | ❌ | n/a | **RETIRED — returns redirect-to-ledger; no status flip** |
| `availableInvoiceActions` | — | — | offered "pay" button | — | — | **drops "pay"** (no legacy button) |

## The single service (`src/lib/invoices/payment-ledger.ts`)
- `applyInvoicePaymentInTx(tx, {...})` — create confirmed InvoicePayment + sync `status`/`paidAt` from the
  ledger (`derivedInvoiceStatus`) inside the caller's tx. Captures `prePaymentStatus` once for exact restore.
- `applyInvoicePaymentReversalInTx(tx, {...})` — append-only reversal (confirmed→reversed) + re-sync; returns
  `ok:false` on a non-confirmed row (double-reversal guard).
- NEVER writes expense/profit/budget.

## Invariant after REM-08
Status can reach `paid`/`partially_paid` ONLY through a confirmed InvoicePayment (recordInvoicePayment /
saveHistoricalInvoice) — no bare `status="paid"` flip exists in the live flow. Verified by
`test:rem-08-invoice-ledger` (15/15) + `pilot:rem-08-invoice-payment-ledger`.
