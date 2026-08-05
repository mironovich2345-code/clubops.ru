# REM-08 — Invoice Payment Design

## Source of truth (spec §4)
```
paidTotal = Σ InvoicePayment.amount where status=confirmed   (reversed rows drop out)
remaining = max(invoice.amount − paidTotal, 0)
state: unpaid (paid=0) · partially_paid (0<paid<total) · paid (paid≥total)
```
`Invoice.status` is a STORED reflection (strategy B — spec §5), written ONLY inside the payment/reversal
transaction via `derivedInvoiceStatus`. It is never the source of `paidTotal`. `paidTotal` is never
computed from `Invoice.status`.

## partially_paid strategy — B (stored, tx-synced)
`partially_paid`/`paid` live in the existing `Invoice.status` column and are set only by the ledger
service inside its transaction. The preflight (`IPL-18`) detects any stored-vs-derived mismatch. (Derived
recomputation on read is available via `derivedInvoiceStatus` for tools/tests.)

## Single service + atomicity (spec §3/§8)
`applyInvoicePaymentInTx` / `applyInvoicePaymentReversalInTx` run inside the caller's `$transaction`:
re-read payments → recompute paidTotal → create/flip the row → sync status/paidAt → (audit outside). A
failure anywhere rolls back the whole effect (proven by failure injection). No helper uses the global
prisma inside the tx; no status change after commit.

## Idempotency (spec §7)
`InvoicePayment.idempotencyKey @unique` (company-scoped in practice via the row's companyId). A repeated
submit with the same key hits the unique constraint → the action catches P2002 and returns success
(benign replay). A different key for the same invoice cannot exceed `remaining` (amount validation +, on
PostgreSQL, the concurrency gate).

## Concurrency (spec §9) — PostgreSQL gate
SQLite proves the LOGIC (single-effect replay, derived state, reversal). Two different-key concurrent
payments must not jointly exceed `remaining`; same-key concurrent must yield one row. That is the
**PostgreSQL staging gate** (`docs/testing/rem-08-invoice-payment-checklist.md`, G-INVLEDGER-10) — NOT
proven on sqlite.

## paidAt / paidById (spec §13)
`paidAt` = the closing (full) payment date; **null while partial/unpaid** (set only when
`paidTotal ≥ total`). It is a compatibility field, not payment history. Payment history is the ledger.

## Reversal (spec §12)
Append-only: the payment row is flipped to `reversed` (never deleted), reason required, chief-accountant
only. `paidTotal` recomputes; status downgrades paid→partially_paid→(pre-payment approved). The recognized
expense is unchanged. A second reversal of the same row is a no-op (`ok:false`).

## Recognition compatibility (spec §19)
The FULL recognized invoice amount stays in profit/budget by `expensePeriod` (REM-05) regardless of
payment/partial/reversal — the payment ledger is liquidity only. Proven: a payment does not change
`calculateProfit` (`test:rem-08-invoice-ledger` 26/27).
