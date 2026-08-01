# Collections operations & control-snapshot polish — pre-change audit

Read-only survey before restructuring `/collections`. **No parallel models are created** — the
unified history is a read model over existing entities; snapshot cancellation reuses the existing
append-only/versioned `BalanceSnapshot`. **Proven formulas are unchanged** (the ИП card «Расходы ИП
на проверке», income/profit/OFD/expenses/invoices/refunds/payroll, transfer model, backdated +
correction rules) — the only calculation change is teaching the snapshot resolver to skip a
`cancelled` point.

## What already exists
- **Page** `src/app/(app)/collections/page.tsx` (order today): header → «Синхронизация ОФД» → per-club
  ООО/ИП cards → AccordionGroup [control (+timeline) → recon → collect/withdraw/other/transfer →
  **transfer-history** → history].
- **Recon** «Фактические деньги» — `ReconciliationForm` + `cash-reconciliation` (daily count vs
  expected; own status). Separate from a control point.
- **Balance cards** `OooCard` / `IpCard` from `loadClubCashBalances` (`cash-balances.ts`).
- **Control-balance form** `OpeningBalanceForm` → `setCashOpeningBalance` (append-only; same-date
  guard; version 1). **Correction** `correctBalanceSnapshot` (supersede + new version, required reason).
- **ООО ops:** `CollectionForm` (инкассация), `WithdrawalForm` (изъятие ООО→ИП). **ИП ops:**
  `OtherIncomeForm` (приход «Иное»), `RegionalTransferForm` (передача регионалу).
- **History today:** `loadCashOpsHistory` (collections + withdrawals + other-income, doc counts) +
  a separate `transfer-history` accordion (`getRegionalTransfersForClub`) + the snapshot timeline
  (`getSnapshotTimeline`). No month filter.
- **Models:** `BalanceSnapshot` (status active|superseded, version, supersedesSnapshotId,
  correctionReason — **no cancellation fields**), `CashCollection`, `CashWithdrawal`,
  `CashOtherIncome`, `CashRegionalTransfer` (pending_confirmation|confirmed|cancelled).
- **RBAC:** `canSetOpeningBalance` (manager/regional/owner/GD/accountant/chief); create ops
  `canCreateOperational`; transfer confirm `isExplicitClubManager`. `ctxForWrite` enforces tenant +
  club scope.

## What only moves (no server change)
- Recon block → **top** (first working block). ООО/ИП balance cards below it. Control balance below.
- Operation forms regrouped into **ООО** and **ИП** columns (desktop 2-col, mobile ООО-then-ИП).
- The standalone **transfer-history** accordion is **removed**; transfers render in the unified history.

## What is unified (read model, no new table)
- One **history** read model merges: collections, withdrawals, other-income, **regional transfers**,
  and control-point events (set / correction / **cancellation**), plus fact reconciliations —
  assembled from existing rows, month-filterable, with sign (+/−/Факт), entity (ООО/ИП), status,
  author, confirmer, docs, «Открыть».

## What requires a server change
- **Snapshot cancellation** action (`cancelBalanceSnapshot`): flip an active point to
  `status = "cancelled"` + set cancellation metadata; **never** edit amount/date, **never** delete.
- **Shared authorization guard** `canManageControlSnapshot(roles)` used identically in UI + create +
  correct + cancel (manager of club / regional with club access / accountant with company+entity
  access; deny cross-company accountant, cross-club manager, regional without club access, inactive).
- **Resolver**: `loadClubCashBalances` already filters `status: "active"`, so a `cancelled` point is
  excluded automatically — confirm + cover by tests. `getSnapshotTimeline` shows cancelled rows.
- **Unified history read model** + **MonthNav** + **history filters** (month/type/entity/status/author),
  all filtering ONLY the history/monthly rows — never the current-balance cards.

## What requires a Prisma migration (additive, non-destructive)
- `BalanceSnapshot`: add `cancelledAt DateTime?`, `cancelledById String?`, `cancellationReason String?`.
  `status` already String → holds `"cancelled"`. Existing rows stay `active`; no recompute, no delete.
- Update `preflight:balance-snapshots` to also report cancelled points / multiple active versions /
  invalid version chains.

## Formulas that stay unchanged
ИП card «Расходы ИП на проверке»; ИП fact balance (snapshot + OFD-after + приход Иное + изъятия −
confirmed transfers − ИП expenses); ООО fact balance; income/profit/OFD/expenses/invoices/refunds/
payroll; backdated + correction rules; transfer pending/confirmed/cancelled semantics. The ONLY
calculation delta: the resolver skips a `cancelled` snapshot (already implied by `status = active`).
