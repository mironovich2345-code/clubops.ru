# REM-02 — Cash Resolver Design

## Shared snapshot rule — `src/lib/cash-snapshot-resolver.ts`
- `activeSnapshotWhere(asOf, {exclusive})` → the canonical WHERE fragment: `status:"active"` +
  `snapshotDate ≤ asOf` (or `< asOf` for as-of-start-of-day reports). The single definition; no reader
  writes its own snapshot filter.
- `resolveActiveSnapshots({companyId?, clubIds, legalEntityIds?, asOf, exclusive}, db)` → Map keyed
  `${clubId}|${legalEntityId}` of the governing active snapshot (latest by snapshotDate, tie by createdAt).
- `CASH_FORMULA_VERSION = "rem-02.v1"` — pinned by every resolver output.

## Single balance service — `src/lib/cash-resolver.ts`
`resolveCashBalance({companyId, clubId, asOf?})` → `{ ooo, ip, asOf, calculatedAt, formulaVersion }` where
each entity is `{ entityType, legalEntityId, balanceKopeks, snapshotSet, snapshotDate, snapshotKopeks,
ofdSinceKopeks, warnings }`. Wraps `loadClubCashBalances` → `calculateCashBalances` (the ratified formula) +
the shared snapshot rule. **Never reads the legacy wallet.** A missing snapshot ⇒ `snapshotSet:false` + a
warning (never a fabricated opening). This is the ONE entry point for dashboard/collections/analytics/guards/
reports/diagnostics.

## Cutover guard — `src/lib/cash-wallets.ts`
`legacyCashWriteDisabled(companyId, db)` → true when `Company.cashCanonicalCutoverAt` is set and ≤ now.
`recordExpenseMovement` returns early when disabled → the legacy CashMovement double-write stops (the
canonical Expense row is the single cash effect). `reverseCashOutflow` is already gated by the presence of an
original movement, so it naturally skips post-cutover. Null cutover → unchanged (backward compatible).

## Why this is safe / minimal
- No third cash ledger: the resolver aggregates the existing **business source rows** (snapshot, OFD, Expense,
  collections, withdrawals, other-income, regional-transfers). Contour B already read the Expense (not the
  CashMovement) for the cash-expense term, so dropping the CashMovement write does **not** change any balance.
- Injectable `db` (tests/tx); pure integer kopeks; server-local day (documented limitation).
- Additive schema (`cashCanonicalCutoverAt`), no legacy deletion, no auto-backfill.
