# REM-02 — Canonical Cash Formulas (official)

Transcribed from `src/lib/cash-balances.ts::calculateCashBalances` (the ratified official contour) +
`cash-collections.ts::loadClubCashBalances` (input assembly). Money = integer kopeks. All day math is
**server-local** calendar day (no per-club timezone; documented limitation).

## Snapshot cutoff rule (the canonical resolver — now shared)
Opening = the **latest `status:"active"` snapshot with `snapshotDate ≤ asOf`**, per (club, legalEntity),
tie-broken by `createdAt` desc. `superseded` and `cancelled` snapshots are excluded. A back-dated active
snapshot never overrides a later active one (later `snapshotDate` wins). `asOf` defaults to now for the
current balance; a historical report passes an explicit `asOf`.

## ИП (`cashIpFactBalance`)
```
cashIpFactBalance =
    ipOpening                                   (latest active ИП snapshot ≤ asOf)
  + Σ OFD ИП cash net  (income − return) after the snapshot day
  + Σ withdrawals ООО→ИП        [pending_review|pending_accountant_review, approved]  after snapshot
  + Σ other income «Приход Иное» [pending, approved]                                   after snapshot
  − Σ regional transfers         [confirmed ONLY]                                      after snapshot
  − Σ ИП cash Expenses (entryVersion=2, paymentMethod=cash) [pending buckets]          after snapshot
  − Σ ИП cash Expenses           [verified/confirmed buckets]                          after snapshot
```
- Models: BalanceSnapshot, OfdDailySalesSummary(taxcom), CashWithdrawal, CashOtherIncome,
  CashRegionalTransfer, Expense{legalEntityId=ИП, paymentMethod:cash, entryVersion:2}.
- **Payroll cash payouts are ИП Expenses** (category salary, entryVersion 2) → already in the two ИП
  cash-Expense terms; **no separate payroll term** (one effect via the Expense row).
- Business date: OFD `date`, operation `operationDate`, expense `expenseDate`; snapshot `snapshotDate`.
- Sign: inflows +, outflows −. Pending vs confirmed per the status sets above (regional transfer = confirmed only).

## ООО (`cashOooFactBalance`)
```
cashOooFactBalance =
    oooOpening                                  (latest active ООО snapshot ≤ asOf)
  + Σ OFD ООО cash net (income − return) after the snapshot day
  − Σ collections (инкассация)   [pending, approved]  after snapshot
  − Σ withdrawals ООО→ИП         [pending, approved]  after snapshot
```
- **No cash-expense term** — ratified rule **B**: ООО is bank-only for expenses; cash flows through ИП
  (the cash-source picker resolves cash → the active ИП). ООО cash expenses do not exist in the model, so
  omitting the term is correct. The picker must keep refusing ООО as a cash source (design invariant).

## Internal transfers (not P&L)
- **ООО→ИП withdrawal:** −ООО and +ИП (both sides modelled) — a move, not income/expense.
- **Transfer to regional:** −ИП (confirmed only). The money left the club to the regional; a
  regional-held balance/debt is tracked separately (not modelled as club cash on the receiving side).
  Not income, not expense.
- **«Приход Иное»:** a cash **inflow** to ИП (money movement, NOT a sale, NOT revenue, NOT profit).

## Formula version
`CASH_FORMULA_VERSION = "rem-02.v1"` — recorded by the resolver so a reconciliation report can pin which
formula produced a number. Any future change to the terms/status-sets bumps this version.
