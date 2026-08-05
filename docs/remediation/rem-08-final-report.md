# REM-08 — Retire Legacy Invoice Pay, Enforce Payment Ledger, Formalize Partially-Paid — Final Report

**1. Baseline commit:** `176a256` (tsc 0 · pilot:full 4095/0 · schemas valid · build:prod compiles).
Additive only; no recognized-expense/profit/budget/cash/payroll/refund formula, RBAC, tenant, AI, or
approval-workflow change (except the payment transition); no production data change.

**2. Legacy payment paths.** The InvoicePayment ledger + idempotency + reversal + post-factum already
existed (partial-payment epic). The one defect: `transitionInvoice(action="pay")` flipped
`Invoice.status="paid"` + `paidAt` via a bare `updateMany` **without** a payment row (ARCH-010/DATA-005/
FIN-006), reachable from the edit form's "pay" button.

**3. Canonical service.** NEW `src/lib/invoices/payment-ledger.ts` — `applyInvoicePaymentInTx` +
`applyInvoicePaymentReversalInTx`, the ONE tx-scoped service. `recordInvoicePayment` +
`reverseInvoicePayment` delegate to it; `saveHistoricalInvoice` remains ledger-backed. **Status can reach
`paid` ONLY via a confirmed InvoicePayment** — the binary pay is retired (transition blocked + "pay"
dropped from `availableInvoiceActions`).

**4. Idempotency.** `InvoicePayment.idempotencyKey @unique`; a repeated submit → P2002 → the action returns
success (benign replay). Proven: same key → one row (`test:rem-08-invoice-ledger` 7).

**5. Concurrency.** SQLite proves the logic; the same-key/different-key/reversal-race is the **PostgreSQL
staging gate** (G-INVLEDGER-10) — NOT proven on sqlite.

**6. Transaction boundaries.** Create/flip + status/paidAt sync happen in the caller's `$transaction`; a
failure rolls back the whole effect (proven by failure injection 11/12). No status change after commit.

**7. Derived payment state.** `paidTotal = Σ confirmed` (reversed excluded); state unpaid/partially_paid/
paid via `derivedInvoiceStatus`. `Invoice.status` is stored + synced only in the tx (strategy B); the
preflight (IPL-18) detects any drift.

**8. paidAt/paidById.** `paidAt` set only when fully paid (null while partial) — compatibility field, not
history. History is the ledger.

**9. Post-factum.** `saveHistoricalInvoice` creates Invoice + InvoicePayment atomically
(`enteredAfterPayment`) — no status=paid without a row.

**10. Reversal.** Append-only (confirmed→reversed, never deleted), chief-only, reason required; recomputes
paidTotal + downgrades status; recognized expense unchanged; double-reversal → `ok:false` (proven 17).

**11. Legacy ledgerless.** Historical paid rows with no ledger stay visible + recognized (REM-05), flagged
`legacy_ledger_missing`; reconciled MANUALLY, never auto-repaired
(`rem-08-legacy-ledgerless-plan.md`).

**12. UI/list/calendar.** `InvoicePaymentPanel` uses the ledger actions; the legacy "pay" button is gone.
(List/calendar already read `paidTotal`/`remaining` from the ledger.)

**13. Profit/budget compatibility.** A payment/partial/reversal NEVER changes the recognized expense or
`calculateProfit` — proven (`test:rem-08-invoice-ledger` 26/27).

**14. Security events.** The REM-07 catalog (`finance.idempotency_conflict` / `overpayment_blocked` /
`closed_period_blocked` / `denied_reversal_role`) is available for the payment denial branches; requestId
correlation is in place. Per-branch `logSecurityDenial` adoption is the REM-07 follow-through.

**15. Preflight result.** `preflight:invoice-payment-ledger` (IPL-01..18) runs clean on dev (0 finance
rows). Real logic; production UNVERIFIED (G-INVLEDGER-9).

**16. Reconciliation result.** `reconcile:invoice-payments` (read-only) — per-invoice ledger vs stored
status + legacy warning; dev has no rows; production review is the gate.

**17. DB tests.** `test:rem-08-invoice-ledger` **15/15** (full/partial/multi, over/zero blocked, idempotent
replay one-row, reversal restore + paid→partial→unpaid, double-reversal no-op, failure-injection rollback,
paidAt-only-full, exact kopeks, **payment does not change profit**).

**18. PostgreSQL gate — NOT EXECUTED** (no PostgreSQL in the sandbox). `rem-08-invoice-payment-checklist.md`
G-INVLEDGER-10.

**19. Findings closure.** **ARCH-010 CLOSED** (0 live callers of the binary pay + single service).
**DATA-005 / FIN-006 CLOSED for all new writes** (status=paid requires a ledger row); **PARTIALLY CLOSED
for historical ledgerless rows** until an accountant reviews the reconciliation on production
(G-INVLEDGER-8/9). **FIN-002 remains CLOSED** (REM-05).

**20. Pilot / full / build.** `pilot:rem-08-invoice-payment-ledger` **29/29** · pilot:full **4123/0 across
95 suites** (one known transient Club/LegalEntity dev.db-lock flake under concurrency; passes 27/0
isolated) · tsc 0 · build:prod **compiles (BUILD_EXIT=0)** · `test:rem-08-invoice-ledger` **15/15** · dev
Prisma client restored after the prod build.

**21. Commits.** service+retirement · preflight+reconcile · tests+pilot+docs (on `main`).

**22. Open live gates.** G-INVLEDGER-1..12 — esp. concurrency (G-INVLEDGER-10), historical reconciliation
(G-INVLEDGER-8/9), no-binary-pay (G-INVLEDGER-12).

**23. Remaining remediation.** Run the PostgreSQL concurrency gate + the production ledgerless
reconciliation; adopt `logSecurityDenial` at the payment denial branches (REM-07 follow-through). Next
candidate: REM-09 (`Company` soft-delete + tenant-scoped export/restore — DATA-008/OPS-016).

## Definition of Done
- InvoicePayment is the only source of payment fact — ✅
- no new paid Invoice without a payment row — ✅ (binary pay retired)
- partial payments supported — ✅ (proven)
- status/payment state consistent — ✅ (synced in tx; preflight detects drift)
- replay + concurrency safe — ✅ replay; ⛔ concurrency = PostgreSQL gate
- reversal restores remaining — ✅ (append-only)
- post-factum invoices create ledger rows — ✅
- historical ledgerless rows visible + not silently repaired — ✅ (warning + manual plan)
- profit/budget unchanged — ✅ (proven)
- production data not automatically modified — ✅
- build + pilots green — ✅ (gauntlet step)
