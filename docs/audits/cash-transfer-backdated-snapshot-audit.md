# Cash movements & backdated control-balance snapshots — pre-change audit

Read-only investigation before implementing (1) «Передать деньги региональному директору»
and (2) backdated / versioned control balances. **The ИП-cash card «Расходы ИП на проверке»
logic is NOT changed** — it correctly sums only unconfirmed cash ИП expenses of the selected
club's active ИП after the last applicable control point.

## 1. Did a "transfer to regional director" operation exist? Where did it go?

**Yes.** Commit `1cc292f` (2026-07-08) — *"Two-way club↔director cash transfers with recipient
confirmation + alerts"* — implemented it on the **legacy wallet ledger**:
- Models `CashWallet` (holders `club_cash` / `regional_cash`) + `CashMovement`
  (`type = internal_transfer`, statuses `pending_confirmation → confirmed`) + `CashNotification`.
- «Клуб → Директор»: created by a club manager or the club's regional director; **confirmed only
  by the target regional director**. «Директор → Клуб»: created only by a regional; confirmed only
  by a club manager. accountant/chief/owner/GD could never stand in for the recipient. Balance came
  from **confirmed** movements only; pending moved nothing; confirmation was transactional +
  idempotent (conditional `PENDING→CONFIRMED`).

**Why it disappeared from the UI.** The cash contour was later reworked (`da673ce` *"stage 2 —
фактические деньги"* and the Collections rebuild) from the **wallet ledger** to the current
**formula-based fact balance**: a `BalanceSnapshot` control point + `CashCollection` /
`CashWithdrawal` / `CashOtherIncome` operations, summed by `src/lib/cash-balances.ts`. The ИП-cash
card and the Collections page were rebuilt on this model; the wallet-ledger transfer screen was not
re-surfaced in the new Collections UI. The operation was **hidden by the UI rebuild**, not deleted
from history.

**What still exists.** `CashWallet` / `CashMovement` / `CashNotification` models remain in the schema
(legacy); `src/lib/cash-wallets.ts` still holds the regional-negative-balance alert thresholds. Old
production `CashMovement` rows of `type=internal_transfer` may still exist — they are **not** read by
the current card/formula and must not be retro-counted (that would double-count against the new model).

## 2. Does the current model already cover it? Decision.

No — the current formula card has **no** "transfer to regional" term. Per the task's own instruction
("не восстанавливать старую реализацию вслепую, если она нарушает текущую модель"), reviving the
wallet ledger would create a **parallel** cash system next to the formula card and risk double
counting. **Decision: add a NEW operation `CashRegionalTransfer` that fits the CURRENT formula model**
(sibling of `CashWithdrawal` / `CashOtherIncome`), and subtract its **confirmed** rows in
`cash-balances.ts`. The legacy wallet models are left untouched (no migration, no reads).

## 3. Related operations already in the balance

`cash-balances.ts` `calculateCashBalances()`:
```
cashIpFactBalance = ipOpening + ipOfdSinceOpening + withdrawalsFromOoo(pending|approved)
                    + otherIncome(pending|approved) − ipExpenses(pending) − ipExpenses(approved)
```
`after(date, ipOpeningDate)` keeps only operations strictly after the ИП control point. The new
transfer adds one subtrahend: `− regionalTransfers(confirmed)`. **No other term changes.**

## 4. «Приход Иное» with source «Региональный директор»

`CashOtherIncome` (`source` ∈ regional/owner/general_director/other) INCREASES the ИП fact balance
(pending|approved). This is exactly the **return path** when a regional gives cash back to the club —
so no separate reverse operation is needed (task §6). (Documents were removed from this form in a
prior stage; historical docs stay read-only.)

## 5. Roles for cash movements today (`collections/actions.ts`)

- **Create** collection/withdrawal/other-income: `canCreateOperational` — club manager / regional
  director (owner/GD only where already allowed).
- **Review/approve** withdrawal & other-income: accountant / chief_accountant / owner / GD / regional.
- **Set control balance** (`canSetOpeningBalance`): manager / regional / owner / GD / accountant / chief.
- Eligible regional directors for a club: `ClubUserAccess`(role=regional_director, active) OR
  `CompanyUserAccess`(role=regional_director, active) — cf. `hasActiveRegionalApproverForClub`.

**Transfer RBAC (task §5), reusing the above:** create by the club's manager or a regional director
with club access; **confirm only by a manager of that club** (a regional cannot self-confirm receipt;
cross-club and accountant/owner/GD cannot stand in). Statuses `pending_confirmation → confirmed →
cancelled`; only **confirmed** affects the balance.

## 6. Current `BalanceSnapshot` model (for the backdated feature)

```
BalanceSnapshot { id, companyId, clubId, legalEntityId, snapshotDate (effective date),
                  actualBalanceKopeks, comment, createdById, createdAt, updatedAt }
```
- **Resolution today** (`loadClubCashBalances`): all snapshots ordered `snapshotDate desc, createdAt
  desc`; the FIRST per entity wins → "latest snapshot by effective date, newest-created on ties".
- **Gaps vs the requirement:** (a) it is a plain row that can be **destructively updated** (`updatedAt`,
  no version/supersede) — task §10/§12 require append-only + corrections; (b) there is no uniqueness on
  `(clubId, legalEntityId, snapshotDate)` — duplicates on one date are possible (task §11); (c) the
  resolver takes the global latest, so a **backdated** earlier point is naturally ignored for the
  current balance (good — matches §8/§9), but historical-interval math and version chains are not modeled.
- **Time semantics:** `snapshotDate` is stored as a `DateTime`; the whole cash contour compares by
  **club-local calendar day** via `ymdLocal()` and `after(date, since)` = `date > since` (strictly
  after the control day). This day-granular, strictly-after rule is the **existing** semantics and is
  kept and documented (task §16).

**Plan for §8–§16 (non-destructive):** add additive columns to `BalanceSnapshot`
(`effectiveDate` alias kept as `snapshotDate`; `status` active|superseded, `supersedesSnapshotId`,
`correctionReason`, `version`); existing rows become `status=active, version=1`. Creation checks for an
existing active point on the same `(club, legalEntity, effectiveDate)` and blocks a plain duplicate
(offer «Скорректировать»). Correction creates a new version pointing at `supersedesSnapshotId` and
flips the old row to `superseded` in one transaction (append-only; the old row is never edited except
its status/superseded pointer). The balance resolver uses the **latest active version whose
effectiveDate ≤ instant** — so adding an earlier point never changes today's balance (governed by the
later point) and only fills the historical interval before the next point.

## Migration & compatibility (task §15)
- Dual schema: `prisma/schema.prisma` (sqlite dev) is the source of truth; `prisma/production/schema.prisma`
  (PostgreSQL) is regenerated via `npm run prisma:sync-prod`. Migrations live in `prisma/migrations`.
- New columns are **nullable / defaulted** → non-destructive; no sums recomputed, no rows deleted.
- A read-only **preflight** (`scripts/preflight-balance-snapshots.mjs`) reports pre-existing same-date
  duplicates, future-dated points, snapshots whose legalEntity is missing, and archived-club snapshots,
  so the operator can reconcile before/after deploy.

## Non-goals (explicitly unchanged)
Profit, revenue, ordinary expenses, OFD sales, bank balances, invoice/refund statuses, tenant
isolation, multi-account, payroll, approvals outside this scope, and the ИП-cash card definition.
