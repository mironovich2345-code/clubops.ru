# REM-08 — Invoice Payment-Ledger Live Acceptance Checklist

Automated proof done (`test:rem-08-invoice-ledger` 15/15; `pilot:rem-08-invoice-payment-ledger`). Live gates:

- [ ] **G-INVLEDGER-1** A full payment creates a confirmed InvoicePayment; status → paid; paidAt set.
- [ ] **G-INVLEDGER-2** A partial payment → `partially_paid`; paidAt null; remaining correct.
- [ ] **G-INVLEDGER-3** A second payment closes the remaining → paid.
- [ ] **G-INVLEDGER-4** Overpayment (> remaining) blocked.
- [ ] **G-INVLEDGER-5** Retry with the same idempotency key → one payment (double-click/timeout safe).
- [ ] **G-INVLEDGER-6** Reversal restores remaining; paid→partially_paid→unpaid; row kept (append-only).
- [ ] **G-INVLEDGER-7** A post-factum invoice creates an InvoicePayment (no status=paid without a row).
- [ ] **G-INVLEDGER-8** Legacy ledgerless paid invoices are visible (not silently "100% paid").
- [ ] **G-INVLEDGER-9** Accountant reviews `reconcile:invoice-payments` on production (read-only).
- [ ] **G-INVLEDGER-10** **PostgreSQL concurrency**: same-key parallel → one row; different-key parallel cannot exceed remaining; reversal race safe.
- [ ] **G-INVLEDGER-11** Profit / budget fact unchanged by any payment/partial/reversal (REM-05 invariant).
- [ ] **G-INVLEDGER-12** No direct binary «pay» action remains (transition retired; no legacy button/endpoint).

## PostgreSQL gate (§25) — NOT EXECUTED in the sandbox (no PostgreSQL)
Run the same-key + different-key concurrency + reversal-race on staging PostgreSQL. SQLite proves the
LOGIC (15/15) but not row-level production concurrency.

**Sign-off:** ARCH-010 CLOSED (0 live callers of the binary pay + single service). DATA-005/FIN-006 CLOSED
for NEW writes; PARTIALLY CLOSED for historical rows until G-INVLEDGER-8/9. G-INVLEDGER-10 is the
production concurrency gate.
