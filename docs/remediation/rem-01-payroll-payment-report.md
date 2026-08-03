# REM-01 — Payroll Payment Safety — Report

## 1. Baseline & result
- **Baseline commit:** `aefeb4f` (tsc clean, pilot:full 3849/0, prisma dev+prod valid, build:prod compiles).
- **Result:** salary payment + reversal + in-period advance + advance-tranche + regional payment are now
  **atomic**; salary payment + regional payment are **idempotent** (DB-unique key). **27/27 real
  DB-backed integration tests pass** (execute the actual service, not a mirror). pilot:full green.

## 2. Payout paths that existed
recordPayment (regular/final), recordAdvance (in-period advance), payoutAdvance + addAdvanceTranche
(pre-period advance), recordRegionalCityPayment (regional), + reversals (cancelPayment / cancelAdvance /
cancelRegionalCityPayment / reverseAdvanceTranche). See `rem-01-payroll-write-graph.md`.

## 3. Where partial writes were
Every payout wrote PayrollPayment/Advance + salary Expense + CashMovement + calc recompute + obligation
refresh as **separate top-level statements on the global prisma client** (no `$transaction`, or — for the
tranche — a `$transaction` that still called `createSalaryExpense` on the global client). A mid-flow
failure orphaned rows; a double-submit created duplicates.

## 4–16. What changed (design)
See `rem-01-payroll-payment-design.md` for the full design. Summary: one shared `executePayrollPayment`
service runs all writes in ONE Serializable `$transaction` using the tx client; idempotency is a DB
`@@unique([companyId, idempotencyKey])` with a param fingerprint; the remaining guard is re-read inside
the tx (TOCTOU closed); the obligation refresh is inside the tx (no swallowed error); reversal is atomic +
idempotent via `executePayrollReversal`; advance + regional get the same transactional guarantee. The UI
sends a stable `idempotencyKey` per attempt (server generates one if absent); error codes map to safe
messages. Helpers thread `db: DbClient = prisma` (defaults keep every other caller unchanged).

## 17–18. Failure-injection + real DB integration tests
`scripts/rem-01-payroll-payment-integration.mjs` (via jiti, executes the REAL service on a disposable
sqlite copy) — **27/27**: one-effect; correct tenant + expense link; calc paid/remaining updated; replay
returns the same payment with no new rows; same-key-different-amount → conflict; overpay/zero/negative
blocked; **rollback at after_payment_create / after_expense_create / after_cash_movement / before_commit**;
after-commit failure + retry → replay (exactly one effect); advance uses the service; **atomic reversal**
(payment canceled + Expense cancelled + compensating inflow); double reversal no-op; reversal restores
remaining; **parallel same-key → one effect**; **parallel different-key can't overpay**. Run:
`npm run test:rem-01-integration`.

## 19. PostgreSQL concurrency gate
The integration test runs on **sqlite** (single-writer), which proves the unique-constraint + retry logic
and rollback semantics but NOT PostgreSQL row-level concurrency. **Before production rollout, run the same
suite against a disposable PostgreSQL** (`DATABASE_URL=<disposable-pg> node
scripts/rem-01-payroll-payment-integration.mjs`) — the Serializable isolation + `@@unique` +
retry-on-`P2034`/`P2002` are designed for postgres, and the concurrency scenarios (23/24) must pass there
too. This is the standing **PostgreSQL concurrency gate** for this task; it is documented, not yet
executed here (no postgres in the sandbox).

## 20. Preflight results (dev, read-only)
`npm run preflight:payroll-payments` — 11 SELECT-only checks (duplicate payments, phantom payment,
missing/mismatched Expense, tenant/legalEntity mismatch, overpay, obligation-lag, regional phantom,
DATA-010 masquerade, legacy nulls). **Dev: 0 offending rows.** Run on a production read replica before &
after rollout (a clean dev result does not prove production).

## 21. Migration results
Additive dev + prod migration `20260803120000_payroll_payment_idempotency` — `ADD COLUMN` (nullable) +
`CREATE UNIQUE INDEX(companyId, idempotencyKey)` on PayrollPayment & RegionalCityPayment. No DROP, no type
change, no data change; multiple NULLs allowed (legacy rows untouched, never auto-backfilled). prisma
dev+prod valid.

## 22–24. Pilots / build
`pilot:rem-01-payroll-payment-safety` 39 structural checks; `test:rem-01-integration` 27/27 behavioral;
**pilot:full 3849/0 across 86 suites**; tsc clean; build:prod compiles.

## 25. Findings closure status
| Finding | Status | Why |
|---|---|---|
| **ARCH-002** payroll recordPayment tx+idempotency | **CLOSED** | recordPayment → atomic service + DB-unique idempotency; proven by integration tests. |
| **DATA-003** PayrollPayment idempotency key | **CLOSED** | `@@unique([companyId, idempotencyKey])` (dev+prod) + fingerprint; duplicates impossible. |
| **FIN-005** double-submit → double payment/expense/cash | **CLOSED** | replay returns existing; parallel same-key = one effect (tests 7,8,17,23). |
| **SEC-001** payroll payout replay | **CLOSED** | idempotency key + fingerprint; replay is a no-op. |
| **ARCH-004** advance payout partly outside tx | **CLOSED** | recordAdvance wrapped in `$transaction`; addAdvanceTranche + payoutAdvance thread tx into createSalaryExpense. |
| **ARCH-003** regional payment tx+idempotency+TOCTOU | **CLOSED** | recordRegionalCityPayment atomic + idempotent + overpay re-checked inside tx. |
| **DATA-016** obligation lags due to swallowed refresh | **CLOSED (for the payout paths)** | refresh runs inside the payment/reversal tx (not swallowed). A future full-recompute reconciliation for other paths remains out of scope. |

**Not closed here (explicitly, for a later REM):** **DATA-010** — `EmployeeFinancialObligation.employeeId`
can still hold a `RegionalCityPayroll.id` when `regionalEmployeeId` is null (a model/semantic change, per
§11 "no big redesign"); the preflight PP-10 detects it. The **dual cash contour** (ARCH-006/FIN-004) is
untouched (REM-02); REM-01 only makes the current contour-A write atomic + non-duplicated. The chief-only
vs operational reversal RBAC question is unchanged (out of REM-01's "no RBAC change" scope).

## 26. Commit hashes
See `git log` — grouped: baseline+write-graph · schema+migration · helper tx-threading · service+27 tests
· payment/advance/reversal migration · advance-tranche+regional · pilot green (audit-gate pins + assertion
updates) · preflight+pilot+docs.

## 27. Manual verification before production
Run the **PostgreSQL concurrency gate** (§19) on staging; run `preflight:payroll-payments` on a prod read
replica; then the one-payment live GATE in `docs/testing/rem-01-payroll-payment-checklist.md` (record a
payment, replay the same key, confirm one effect, reverse, confirm full restoration).

## 28. Remaining for REM-02+
DATA-010 (regional obligation employeeId), the dual cash-contour collapse (ARCH-006/FIN-004/DATA-002), the
chief-only reversal RBAC alignment, and threading tx through the separate employee-debt settlement flow
(`payroll/obligations/actions.ts` postCashOutflow/postCashInflow).

## Definition of Done — met
One logical payout = one effect ✅ · all related writes atomic ✅ · retry/double-click/parallel safe ✅ ·
advance + regional same protection ✅ · reversal atomic ✅ · **real DB tests prove rollback + replay ✅** ·
salary formulas unchanged ✅ · production data not auto-changed ✅ · build + pilot:full green ✅.
(PostgreSQL concurrency gate = documented, to run on staging before go-live.)
