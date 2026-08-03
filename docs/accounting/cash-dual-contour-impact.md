# CLUB-OPS — Dual Cash-Contour Impact

Financial reconciliation model for the two cash systems at `d161c15` (extends Audit-2
`cash-contours-reconciliation.md`). **A** = legacy `CashWallet`/`CashMovement` (confirmed-only). **B**
= current `BalanceSnapshot` + collections/withdrawals/other-income/regional-transfers + OFD →
`calculateCashBalances` (pending-counting). Money = kopeks.

## Cash ООО formula (contour B) — `cash-balances.ts:158`
```
cashOooFactBalance = opening(active snapshot)
  + OFD ООО cash net since checkpoint
  − collections(pending_accountant_review + approved)
  − withdrawals ООО→ИП(pending_review + approved)
```
**There is NO ООО cash-expense term** → a cash expense booked on the ООО entity is **invisible** to
the ООО balance (FIN-016). pending already moves the balance.

**Competing ООО figures (FIN-004 / DATA-001):** (1) `cashOooFactBalance` (dashboard `oooFactKopeks`,
collections, reconciliation); (2) `getLatestBalancesByClub.oooKopeks` = raw latest snapshot (drives
the risk color on the **same** card, `dashboard-cards.ts:95`); (3) `analytics.ExecutiveSummary.cashOooRemainingKopeks`
= Σ(SalesReport `cash_ooo − encashment`) (`analytics.ts:536`). One club, same instant → up to **three**
"ООО cash" numbers.

## Cash ИП formula (contour B) — `cash-balances.ts:143`
```
cashIpFactBalance = opening(active ИП snapshot)
  + OFD ИП cash net since checkpoint
  + withdrawals ООО→ИП(pending+approved)
  + «Иное» (CashOtherIncome, pending+approved)
  − regional transfers(confirmed ONLY)
  − ИП cash expenses(pending review stages + verified/confirmed)
```
Scope: expenses restricted to `legalEntityId=ИП, paymentMethod=cash, entryVersion=2` — a **v1 or bank
expense never touches contour B**.

**Competing ИП figure:** legacy `walletBalanceKopeks(club_cash)` = Σ confirmed `toWallet` − Σ confirmed
`fromWallet` (`cash-wallets.ts:59`). Structural divergences: A is confirmed-only, A has **no OFD income**
(the `ofd_cash_income` movement type is never written), A's opening is a separate record.

## Synthetic divergence (made-up numbers — NOT from the DB)
ИП club, checkpoint 2026-07-01, evaluated "now":
| Event | Amount | Contour A (wallet) | Contour B (fact) |
|---|---|---|---|
| Opening (wallet 100 000; snapshot 100 000) | 100 000 | +100 000 | +100 000 |
| ИП OFD cash income after 07-01 | 50 000 | **+0** (no OFD movement) | **+50 000** |
| «Иное», still `pending_review` | 10 000 | **+0** (pending≠confirmed) | **+10 000** |
| ИП cash expense, status `submitted` | 20 000 | **−0** (posted only on verify) | **−20 000** |
| **Total** | | **100 000 ₽** | **140 000 ₽** |
**Divergence = 40 000 ₽** at the same instant, from (a) OFD absent in A, (b) pending-vs-confirmed, (c)
expense-on-verify. Only B is displayed; A holds a different, unsurfaced truth.

## Snapshot lifecycle effects on B
- **Cancelled snapshot** → dropped by `status:"active"`; opening falls back to next active or `{0, null}`; with `date=null`, `after(d,null)=true` so **all** OFD+movements from time-zero recount → the balance can jump.
- **Correction** → new version same `snapshotDate` supersedes; newest wins; window unchanged.
- **Backdated snapshot** → does NOT override a later one (resolver keeps latest `snapshotDate`); only matters if it becomes the latest checkpoint (moves the window earlier).

## Per-operation contour impact (§13)
| Operation | Writes A? | Writes B? | Reads A | Reads B | Divergence? |
|---|---|---|---|---|---|
| opening balance | yes (movement) | yes (separate snapshot) | wallet | opening | **yes** (two records) |
| ИП cash expense | yes (on verify) | yes (Expense, counted while pending) | wallet | ИП expense | **yes** (timing) |
| ООО cash expense | yes (if ООО wallet) | **no term** | wallet | — | **yes** (invisible to B) |
| payroll payout (cash) | yes (Expense→movement) | yes if ИП | wallet | ИП expense | **yes** (ООО payroll hits A only) |
| advance (cash) | yes | yes if ИП | wallet | ИП expense | **yes** |
| other income «Иное» | yes (confirmed after confirm) | yes (pending) | wallet | ИП other income | **yes** (pending) |
| collection | **no** | yes | — | ООО collections | B-only |
| withdrawal ООО→ИП | **no** | yes | — | both entities | B-only |
| regional transfer | separate table | yes (confirmed) | — | ИП transfers | B-only |
| internal transfer (wallet↔wallet) | yes | **no** | wallet | — | A-only |
| correction/reversal | compensating inflow | snapshot version / expense cancel | wallet | opening/expense | **yes** (independent) |

**No code reconciles A against B.** Collections/withdrawals/OFD/snapshots are B-only; internal wallet
transfers and the (never-written) wallet OFD slot are A-only; expenses/payroll/other-income write both
but on different triggers (pending vs confirmed) and only for the ИП entity.

## Conclusion (business decision BD-09)
Canonical = **B**. A is legacy, still written, never read on the cash page, no reconciliation. To
collapse to one contour: source the cash effect of expenses/payroll from the `Expense` row only (as B
does) and make the `CashMovement` writes **audit-only** or drop them — a change requiring a data audit +
migration (out of scope here; remediation FIN-004/DATA-002, gated).
