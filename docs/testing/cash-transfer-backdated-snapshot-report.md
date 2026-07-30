# Cash transfer + backdated snapshot — implementation report

Two product features shipped without touching the ИП-cash card definition, profit, revenue,
ordinary expenses, OFD sales, bank balances, invoice/refund statuses, tenant isolation,
multi-account, payroll, or out-of-scope approvals.

## 1. Why the transfer-to-regional operation had disappeared
It existed on the **legacy wallet ledger** (`CashWallet` / `CashMovement type=internal_transfer`,
commit `1cc292f`). When the cash contour was rebuilt on the **formula-based fact balance**
(`BalanceSnapshot` + `CashCollection`/`CashWithdrawal`/`CashOtherIncome` + `cash-balances.ts`), the
wallet-ledger transfer screen was not re-surfaced — hidden by the UI rebuild, not deleted.

## 2. Restored old model or new one?
**New model.** Reviving the wallet ledger would run parallel to the formula card and risk double
counting. Added `CashRegionalTransfer` (sibling of `CashWithdrawal`/`CashOtherIncome`) that fits the
current formula; the legacy wallet models were left untouched.

## 3–6. Roles, confirmation, balance effect, "not an expense"
- **Create:** club manager or regional director with club access (`canCreateOperational`).
- **Confirm:** only an **explicit** manager of that club (`isExplicitClubManager` — a regional's
  implied-manager role does not qualify; cross-club / accountant / owner / GD cannot stand in).
  Statuses `pending_confirmation → confirmed → cancelled`; idempotent conditional update.
- **Balance:** only **confirmed** reduces the ИП fact balance (`REGIONAL_TRANSFER_FACT_STATUSES =
  ["confirmed"]`), subtracted once via the formula; `pending`/`cancelled` move nothing. It is a cash
  movement, not an expense: `createRegionalTransfer` writes only `cashRegionalTransfer` (no
  `expense.create`), so profit/revenue/OFD/bank are unaffected.

## 7. Return path
Money returned by a regional → existing **«Приход Иное»** (source `regional`), which increases the ИП
balance and is not revenue. No reverse operation added.

## 8–13. Backdated snapshots
- Adding **01.07** after **02.07**: the 02.07 point is not deleted or changed and stays the current
  point; today's balance is computed from 02.07; the 01.07 point only fills the **01.07→02.07**
  interval. Resolver = latest **active** version with `snapshotDate ≤ now`.
- **Same date:** at most one active point per (club, entity, date); a plain duplicate is refused
  («используйте корректировку»).
- **Correction:** append-only — old row flips to `superseded` (never edited), a new
  `version+1`/`supersedesSnapshotId` row is created with a required reason; corrections chain
  sequentially; no parallel active versions; nothing deleted. History fully auditable via the
  version timeline (with coverage intervals). Same-day ordering: `snapshotDate desc, createdAt/
  version desc`; movements strictly after the point by calendar day.

## 14. Migrations
- Dev sqlite migration applied; prod postgres migration is additive (`ADD COLUMN` +
  `CREATE TABLE`) — no recompute, no deletes. Both schemas validate; `build:prod` regenerates the
  prod client and compiles.
- Read-only `preflight:balance-snapshots` reports dupes / future dates / orphan LE / archived clubs.

## 15. Tests / build
- `pilot:cash-transfer-backdated-snapshot` — **30/30** (form/RBAC/model + runtime formula &
  resolver: confirmed reduces, pending/cancelled don't, backdated keeps later fact, corrections
  append-only, kopeks-exact, deterministic ordering).
- `pilot:full` — **3468 passed, 0 failed across 76 suites**. `tsc` clean. Prisma dev + prod valid.
  `build:prod` compiled (exit 0).

## 16. Commit hashes
See `git log` on `main`: audit → model+migration → actions/formula/versioning → UI/history/timeline
→ tests/preflight → docs. (Hashes listed in the final chat report.)

## 17. Remaining manual checks
On a real instance with seeded roles, verify per `docs/testing/cash-transfer-backdated-snapshot-checklist.md`:
a confirmed transfer actually lowers the ИП balance and nothing else; RBAC (regional cannot
self-confirm, cross-club denied); backdated 01.07 after 02.07 leaves today's balance intact and only
changes the 01.07→02.07 interval; correction append-only + timeline auditable.
