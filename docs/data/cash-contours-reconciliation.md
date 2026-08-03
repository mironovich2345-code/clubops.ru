# CLUB-OPS — Cash Contours Reconciliation (ARCH-006 / DATA-002 deep dive)

Two parallel cash systems exist. They share **no tables** and can diverge on every ИП/ООО number.
Read-only analysis at `66bc9e3`. **No migration or disable is proposed here** — this documents the
split and names the canonical contour for a later, gated remediation.

## Contour A — legacy `CashWallet` + `CashMovement` (confirmed-only ledger)
- Balance = Σ confirmed `toWallet` − Σ confirmed `fromWallet` (`cash-wallets.ts:59-65`). Only `status:"confirmed"` rows count. `@@unique([sourceType,sourceId])` = idempotency.
- **Remaining writers** (still create movements): opening balance (`cash-wallets.ts:157`), internal transfer create/confirm (`:232,:277`), other-cash-income (`:367`), **cash expense verify** (`recordExpenseMovement` `:132` ← `simplified-actions.ts:295`), **payroll cash payout/advance** (`payroll/payments.ts:40` ← `salary-expense.ts:65`), payroll cancel/repay compensating inflow (`payments.ts:77,123`).
- **Readers:** only the `/expenses/cash` page (`club-cash-cards.ts:54-71` → «Остаток наличных ИП», regional breakdown, «Приход Иное»). No dashboard/analytics/collections reader consumes contour A. UI is retired (`expenses/cash/page.tsx:10-15` is a read-only pointer to `/collections`).

## Contour B — current `BalanceSnapshot` + operations + `calculateCashBalances` (fact, pending-counting)
- Fact = latest active snapshot (opening) + OFD cash since checkpoint + withdrawals + «Иное»(`CashOtherIncome`) − regional transfers(confirmed) − ИП cash expenses(`Expense`) (`cash-balances.ts:128-188`). **PENDING already moves money.**
- **Writers:** `collections/actions.ts` (snapshot/collection/withdrawal/other-income/regional-transfer) + reconciliation. Cash expenses reach B through the ordinary `Expense` row (no B-specific write).
- **Readers:** `/collections`, `/expenses`, `/analytics`, dashboard club cards (`oooFactKopeks`/`ipFactKopeks`), scope summary, reconciliation. **This is what every financial screen consumes.**

## Same-operation DOUBLE-WRITES (both contours mutate)
1. **Cash expense** → `Expense` row (B fact, `cash-balances.ts:141`) **and** `CashMovement.expense` (A wallet, `cash-wallets.ts:132`). Both reduce ИП cash.
2. **Payroll cash payout/advance** → one salary `Expense` (counted in B fact) **and** `CashMovement.payroll_payout` (A wallet). `salary-expense.ts:1-7` explicitly relies on `recordExpenseMovement`.
3. **«Приход Иное»** — a **split-write**: `/expenses/cash` writes A (`CashMovement.other_cash_income`); `/collections` writes B (`CashOtherIncome`). Two features, two tables.

## Why the two balances diverge (structural, not incidental)
- **Status semantics:** A counts only `confirmed`; B counts `pending`/`approved` too (`cash-balances.ts:36-52`). A pending op moves B but not A.
- **OFD:** B adds OFD cash income since checkpoint; A has **no** OFD income movement (the `ofd_cash_income` type is defined but never written). → A can never equal B once OFD cash exists.
- **Opening:** A = `CashMovement.opening_balance`; B = `BalanceSnapshot`. Independent values, set on different pages.
- **Collections/withdrawals/regional transfers** exist only in B. A "regional" uses an unrelated `CashMovement.internal_transfer` ledger.

**Net:** for a real club with OFD + collections, **A and B are guaranteed to differ**, and the
dashboard even renders both ООО numbers (`oooKopeks` snapshot vs `oooFactKopeks` fact,
`dashboard-cards.ts:95,116`) and both ИП numbers side-by-side — the divergence is user-visible.

## Snapshot-resolver inconsistency (feeds ARCH-001)
The fact-balance loader filters `status:"active" + snapshotDate ≤ now` (`cash-collections.ts:37`);
the dashboard/scope readers (`balance-snapshots.ts:23-27`) **do not filter `status:"active"`** →
after a cancellation the dashboard sums a cancelled snapshot while the cash contour reads 0.

## Conclusion (for a later, gated remediation — NOT done here)
- **Canonical contour = B** (`BalanceSnapshot` + collections/withdrawals/other-income/regional-transfers + OFD summaries → `calculateCashBalances`). Every financial reader already uses it; reconciliation validates against it.
- **Historical / deprecate = Contour A** (`CashWallet`, `CashMovement`, `club-cash-cards.ts`, `/expenses/cash`, `cash-actions.ts`). Evidence it is legacy: `balance.ts:6-8` calls ИП wallet "null today"; the OFD-income movement type is never written; no analytics reader touches it.
- **Blocker to retiring A:** cash expenses & payroll payouts currently depend on contour A's `recordExpenseMovement`/`postCashOutflow` for **idempotency + reversal**, even though the *balance effect* is double-counted. To collapse to B, the cash effect of expenses/payroll must be sourced from the `Expense` row only (as B already does) and the `CashMovement` writes dropped or made **audit-only** — a change requiring a data audit + migration (out of scope for this read-only audit; see remediation backlog DATA-002/006).

## Existing dev-DB state
`audit:data-integrity` DATA-CHK-25: 11 companies; the two contours were not numerically reconciled
in dev (little data). **Production must be checked** by computing, per club/LE, the contour-A wallet
balance vs the contour-B fact balance and listing divergences.
