# Collections operations & control-snapshot polish — report

Final daily-use structure for `/collections`. The proven ИП-card «Расходы ИП на проверке» formula
and all out-of-scope calculations are unchanged; the only calculation delta is the snapshot
resolver skipping a `cancelled` point.

## 1. Original vs 2. New page order
**Before:** header → «Синхронизация ОФД» → ООО/ИП cards → accordions [control → recon →
collect/withdraw/other/transfer → **transfer-history** → history].
**After:** header + **MonthNav** → **«Фактические деньги» (recon, first open block)** → current
ООО/ИП balance cards → control balance (+ correction/**cancellation** + timeline) → **operations
split ООО | ИП** → **unified month-filtered history**. Recon review history kept at the bottom.

## 3. Where the actual-cash block is
At the **top**, as the first working block — it is the daily count (A), explicitly distinguished
from a control point (B); a reconciliation never auto-becomes a control point.

## 4. ООО / ИП split
«Операции с наличными» → desktop two equal columns: **ООО** (Инкассировать ООО, Изъять ООО→ИП) and
**ИП** (Приход «Иное», Передать регионалу). Mobile: one column, ООО then ИП. Full-width controls.

## 5. Separate transfer block removed without data loss
The standalone «Передачи региональному директору» accordion and its `getRegionalTransfersForClub`
page call are removed. **No data or behavior lost** — `CashRegionalTransfer`, statuses, RBAC,
manager confirmation, recipient snapshot, audit, and the confirmed-reduces-balance rule are intact;
transfers now render in the unified history (with confirm/cancel actions).

## 6. Unified history
`loadCollectionsHistory` is a **read model over existing rows** (no new table): reconciliations,
control points (set / correction / cancellation), ООО collections, ООО→ИП withdrawals, ИП «Иное»,
regional transfers. Each row: effective date, created date, type, entity (ООО/ИП), amount + sign
(«+» приход / «−» выбытие / «Факт» for snapshots+recon), club, source/recipient, status, author,
confirmer, docs. Desktop table + mobile cards; review/cancel + transfer confirm preserved.

## 7–8. What is month-filtered / stays current
**Month-filtered:** the history rows and the monthly totals (ОФД cash ООО/ИП, инкассации, изъятия,
приход «Иное», передачи confirmed, наличные расходы ИП, число сверок) — via club-local calendar
`monthBounds` (integer kopeks). **Stay current («Сейчас»):** the ООО/ИП balance cards from
`loadClubCashBalances` (no month param). Filters (type/entity/status/author) change only the rows.

## 9. Who may create a control point
Shared `canManageControlSnapshot(roles)` (manager / regional / accountant / owner / GD / chief) used
identically in the UI, every action (create/correct/cancel), and the tests; **scope** enforced by
`ctxForWrite` (selectedCompanyId + clubId ∈ allowedClubIds) — a cross-company accountant, a
cross-club manager, and a regional without club access are denied.

## 10–12. Cancellation model & post-cancel calculation
**Model:** `status = "cancelled"` on the same row + `cancelledAt/ById/Reason` (additive columns);
amount/date never edited; append-only; **no hard delete**. Chosen over a "cancelling version" row
because a cancellation carries no new amount — a status flip + metadata is the minimal, auditable
change, symmetric with the existing `superseded` flip. **After cancel** the resolver (status=active
only) uses the **previous applicable** active point; **later active points are unchanged**; the
cancelled row stays visible in the timeline with its reason.

## 13. Backdated & correction preserved
Earlier point can be added; later point stays a fact; current balance uses the latest applicable
point; same-date duplicate refused; correction creates a new version with a required reason;
superseded rows remain; only the latest active version per date applies. Cancellation is integrated
into the same resolver + timeline.

## 14–15. Migration & preflight
Additive migrations (dev sqlite + prod postgres): `BalanceSnapshot ADD cancelledAt/cancelledById/
cancellationReason`; `status` holds `cancelled`. No recompute, no delete, existing rows stay active.
`preflight:balance-snapshots` now also reports cancelled points + broken version chains.

## 16. Tests / build
`pilot:collections-operations-polish` **34/34**; `pilot:full` **3502/0 across 77 suites**;
`tsc` clean; prisma dev + prod valid; `build:prod` compiled.

## 17. Commit hashes
See `git log` on `main`: audit → snapshot cancellation model/guard/action → page/unified-history UI
→ tests → docs.

## 18. Manual checks
Follow `collections-operations-polish-checklist.md`: recon-first layout; ООО/ИП split on desktop +
mobile; transfers only in the common history; MonthNav filters history but not the balance cards;
regional/accountant can create a control point in scope; cancellation keeps history + switches the
resolver to the previous point; no destructive delete.
