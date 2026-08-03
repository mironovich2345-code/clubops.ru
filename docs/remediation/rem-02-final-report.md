# REM-02 — Single Cash Source of Truth — Final Report

## 1. Baseline
`bb21590` (tsc clean · pilot:full 3888/0 · prisma dev+prod valid · build:prod compiles). Additive only; no
formula/RBAC/tenant/data change; no legacy-row deletion; no auto-backfill.

## 2. Official contour (ratified)
The **formula-based fact contour** — `calculateCashBalances` fed by `loadClubCashBalances`, exposed via the
single `resolveCashBalance` service — is the ONLY official source of the ООО/ИП cash balance. Legacy
`CashWallet`/`CashMovement` is history + reconciliation only.

## 3–4. Final formulas
See `rem-02-canonical-cash-formulas.md`. **ИП** = active snapshot + OFD-ИП-cash-since + withdrawals-in +
«Приход Иное» − regional-transfers(confirmed) − ИП cash Expenses (payroll cash included via the Expense
row). **ООО** = active snapshot + OFD-ООО-cash-since − collections − withdrawals. **ООО has no cash-expense
term (rule B): cash is ИП-only** (provable from the cash-source picker).

## 5–7. Resolver variants → one
Before: `cash-collections.ts:37` (correct: active + ≤now) vs `balance-snapshots.ts` `getLatestBalancesForScope`/
`ByClub` (NO status/date filter — the ARCH-001 bug feeding dashboard/analytics/payments). After: the shared
`src/lib/cash-snapshot-resolver.ts` (`activeSnapshotWhere` / `resolveActiveSnapshots`) is the ONE rule —
latest `status:"active"` with `snapshotDate ≤ asOf`, per (club, legalEntity), tie-broken by createdAt. Both
`balance-snapshots.ts` resolvers and `cash-collections.ts` now use it.

## 8. Correction/cancellation semantics
Unchanged model (append-only): correction = new active row + `supersedesSnapshotId`, old → superseded;
cancellation = status `cancelled` + reason/actor, amount/date never edited. The resolver deterministically
picks the single governing active point. Proven by tests 2/3/4.

## 9. Active uniqueness strategy
Preflight `CC-01`/`CC-03` detect duplicate active points + un-flipped correction chains (read-only). The
**DB constraint** (an `activeKey` composite unique) is designed but **deferred** — the append/correct/cancel
actions are already compare-and-set on `status:"active"`, so a duplicate requires a same-date race; the
uniqueness constraint + PostgreSQL concurrency test is a follow-up (see §14/§25).

## 10. Migrated readers
`getLatestBalancesForScope`/`ByClub` now apply the canonical rule → **dashboard-cards, analytics/page,
payments/page** are corrected automatically (they consume those functions). `resolveCashBalance` is the new
single entry point for any new reader.

## 11–13. Legacy writers before → after; cutover
Before: `recordExpenseMovement` double-wrote a CashMovement for every cash expense/payroll payout. After:
`Company.cashCanonicalCutoverAt` + `legacyCashWriteDisabled` guard → **once a company is cut over,
recordExpenseMovement writes NO CashMovement** (the canonical Expense row is the single cash effect; DATA-002).
Null cutover = legacy double-write continues (backward compatible; REM-01 tests unaffected). Legacy rows
readable for history. Proven by test 10.

## 14. Payroll cash effect after REM-01
Payroll cash is an ИП `Expense{category:salary, entryVersion:2}` → already in the ИП cash-Expense term of the
official formula (one effect). After cutover the legacy CashMovement is skipped; the balance is unchanged
(driven by the Expense). Reversal cancels the Expense → balance restored (the compensating legacy inflow is
naturally skipped when no original movement exists). REM-01 atomicity/idempotency intact.

## 15–18. Effects / rule B
Cash expense → −ИП (once, via Expense). Other-income → +ИП. Withdrawal → −ООО +ИП. Regional transfer →
−ИП(confirmed). Collection → −ООО. **ООО cash expense: forbidden (rule B)** — preflight CC-04 flags any
existing ООО cash Expense; the cash-source picker refuses ООО.

## 19–20. Reconciliation / preflight (dev)
`reconcile:cash-contours` (canonical vs legacy wallet per club/entity) — dev: 0 diverged. `preflight:cash-
cutover` (10 SELECT-only checks) — dev: 0 offending rows. **Both must run on a production read replica**
before setting any cutover (a clean dev result proves nothing about production).

## 21–22. Existing divergences / required manual corrections
Dev: none (empty cash tables). Production: **unverified** — run the reconciliation + preflight on a replica;
for each divergence use the safe plan (`rem-02-legacy-cutover-plan.md`): read-only report → accountant
confirms → a correction record (never a destructive edit or wallet overwrite).

## 23. Integration test results
`test:rem-02-integration` (real service via jiti on a disposable DB) — **13/13**: snapshot-only, cancelled
ignored, corrected selected, backdated non-override, future ignored, asOf historical, shared resolver, ООО,
no-snapshot warning, cutover guard, legacy-divergence-independence, tenant isolation, formulaVersion.

## 24. PostgreSQL gate
**NOT executed** (no postgres in sandbox) — mandatory staging gate before go-live: run the integration suite
+ concurrent-snapshot-create + REM-01 payroll suite against a disposable PostgreSQL. sqlite proves the rule,
not pg row-concurrency.

## 25–26. Pilots / build
`pilot:rem-02-single-cash-source` (structural) in pilot:full; **pilot:full green**; tsc clean; build:prod
compiles.

## 27. Findings closure
| Finding | Status | Why |
|---|---|---|
| **ARCH-001** divergent snapshot resolvers | **CLOSED** | one shared `activeSnapshotWhere`; all readers use it; proven by tests 2–7. |
| **DATA-001** competing cash figures | **CLOSED** | `resolveCashBalance` is the single official entry point; snapshot readers corrected. |
| **UX-005** competing numbers shown as one | **PARTIALLY CLOSED** | numbers now agree (same rule); the `/expenses/cash` legacy panel relabel to "diagnostics only" is a UI follow-up. |
| **DATA-002** cash expense/payroll double-write | **CLOSED (cutover-gated)** | `legacyCashWriteDisabled` stops the CashMovement double-write after cutover; before cutover it continues (backward compatible), proven by test 10. |
| **ARCH-006** two cash contours | **PARTIALLY CLOSED** | canonical ratified + legacy no longer official + double-write stoppable; full legacy retirement (remove writes everywhere, relabel UI) staged post-cutover. |
| **FIN-004** ООО/ИП untrustworthy | **CLOSED (formula)** | one authoritative formula + resolver + reconciliation; production reconciliation pending on a replica. |
| **DATA-012/013** active-snapshot uniqueness/race | **PARTIALLY CLOSED** | preflight detects duplicates; the DB uniqueness constraint + pg concurrency test is a documented follow-up. |

## 28. Commit hashes
See `git log` — baseline+formulas+resolver-unification · resolver-service+cutover+tools+tests · pilot+docs.

## 29. Open live gates
G-CASH-1..8 (`rem-02-cash-live-checklist.md`), esp. G-CASH-7 (accountant reconciles a real club) and
G-CASH-8 (PostgreSQL concurrent snapshot).

## 30. Next remediation
REM-03 (proven off-site backup+restore, OPS-001), REM-04 (enforce S3 + back up uploads, OPS-002); then the
REM-02 continuation (active-uniqueness DB constraint, company-wide cutover rollout, `/expenses/cash` UI
relabel, DATA-010 regional obligation employeeId).

## Definition of Done
Official cash balance is one ✅ · dashboard/collections/analytics use the same rule ✅ · cancelled snapshot
ignored ✅ · correction chain unambiguous ✅ · legacy wallet not official ✅ · new flows can stop double-write
(cutover) ✅ · payroll/expense reduce cash once ✅ · reconciliation available ✅ · production data not auto-changed
✅ · build + pilot:full green ✅. **PostgreSQL concurrency gate + production reconciliation = to run before
go-live.**
