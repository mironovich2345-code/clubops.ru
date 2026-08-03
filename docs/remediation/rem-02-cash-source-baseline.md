# REM-02 — Single Cash Source of Truth — Baseline

Second remediation task. Ratified business decision: **the formula-based (fact) contour is the ONLY
official source of the ООО and ИП cash balance.** Legacy `CashWallet`/`CashMovement` is history +
reconciliation only. Additive only — no formula/RBAC/tenant/production-data change; **no legacy row
deletion**; no automatic backfill.

## Audited baseline
- **HEAD:** `bb21590` · **branch:** `main` · **vs origin:** 10 ahead (REM-01 unpushed) · **tree:** clean.
- **tsc:** clean. **prisma:** dev+prod valid. **pilot:full:** 3888/0 across 87 suites. **build:prod:** compiles.
- Dev cash tables: empty (minimal seed) — reconciliation must run on a production read replica.

## Related findings in scope
ARCH-001 (divergent snapshot resolvers), ARCH-006 (two contours), DATA-001 (competing cash figures),
DATA-002 (cash expense/payroll double-write), FIN-004 (ООО/ИП untrustworthy), UX-005 (competing numbers
shown as one), DATA-012/013 (active-snapshot uniqueness / race).

## Current writers / readers
- **Canonical contour B** — `src/lib/cash-balances.ts::calculateCashBalances` fed by
  `cash-collections.ts::loadClubCashBalances` (snapshot + OFD cash + collections + withdrawals +
  other-income + regional-transfers + **ИП** cash Expenses). Readers: `/collections`, `/analytics`,
  dashboard cards (`oooFactKopeks`/`ipFactKopeks`), scope summary, reconciliation.
- **Snapshot display (divergent — ARCH-001)** — `balance-snapshots.ts::getLatestBalancesForScope` /
  `getLatestBalancesByClub` pick the latest snapshot **without `status:"active"` and without a date
  cutoff**. Read by `dashboard-cards.ts`, `analytics/page.tsx`, `payments/page.tsx`. The correct rule
  lives only in `cash-collections.ts:37` (`status:"active" + snapshotDate ≤ now`). **This is the bug.**
- **Legacy contour A** — `cash-wallets.ts` (`walletBalanceKopeks` = Σ confirmed CashMovement). Read only
  by `/expenses/cash` via `club-cash-cards.ts`. Written (double-write) by `recordExpenseMovement`
  (every cash expense/payroll payout) + opening/transfer/other-income legacy actions.

## Confirmed: the ООО cash-expense-term question (Audit-3) → decision **B**
`calculateCashBalances` computes `cashOooFactBalance = opening + OFD − collections − withdrawals` with
**no cash-expense term**, while ИП subtracts cash Expenses. This is **correct by design, not an
omission**: cash always flows through the **ИП** — `pickPaymentLegalEntity`/`resolveCashWallet` (payroll)
and `resolveActiveIpForClub` (expenses) resolve **cash → the club's active ИП**; ООО is bank-only for
expenses. So **ООО has no cash expenses** ⇒ no term needed. REM-02 ratifies rule **B** and (design) the
cash-source picker must keep refusing ООО as a cash source. See `rem-02-canonical-cash-formulas.md`.

## Scope of this task (honest)
Delivered here: snapshot resolver unification (ARCH-001), a single `resolveCashBalance` entry point,
active-snapshot uniqueness preflight, a cutover setting + legacy-write guard, a read-only reconciliation
tool + cash-cutover preflight, real DB-backed integration tests, docs. **Continuation (documented in the
final report):** migrating every one of the ~4 divergent readers is done by the resolver fix; the full
active-uniqueness DB constraint, the company-wide cutover rollout, and the `/expenses/cash` UI relabel are
staged with tooling ready.
