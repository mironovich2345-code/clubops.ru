# Control-balance (BalanceSnapshot) guide — append-only & backdated

A **control point** (`BalanceSnapshot`) records the physically-counted cash of a club's legal
entity on an **effective date** (`snapshotDate`). Control points are **append-only** and
**versioned**.

## Time semantics (unchanged, now documented)
- `snapshotDate` = the club-local **calendar date** of the count.
- A movement counts toward a balance when its date is **strictly after** the control point's
  effective date: `date > effectiveDate` (day granularity via `ymdLocal`). A movement on the SAME
  day as the control point is considered captured by the count and does **not** re-apply.
- Ordering is deterministic: `snapshotDate desc, then createdAt/version desc`.

## Applying control points (§9)
For a balance at instant *T*, the resolver uses the **latest ACTIVE version whose
`snapshotDate ≤ T`**, then applies the movements after it (up to *T*, or up to the next control
point for a historical interval). Superseded correction versions are ignored.

### Backdated example
```
01.07.2026 — 0,98 ₽        (added later, backdated)
02.07.2026 — 15 509,92 ₽   (added first)
```
- Balance for **01.07** uses the 01.07 point; the interval **01.07 → 02.07** is computed from 0,98 ₽.
- Balance from **02.07** uses the 02.07 point; today's balance is computed from 15 509,92 ₽.
- **Adding the 01.07 point does NOT** delete or change the 02.07 point, does not become the current
  point, and does not change today's balance — it only fills the historical interval before 02.07.

## Same-date rule (§11)
At most **one active** control point per `(clubId, legalEntityId, effectiveDate)`. Trying to create
a second on the same date is refused:
> «На эту дату уже существует контрольная точка. Используйте корректировку.»

## Correction (§12) — append-only
«Скорректировать контрольную точку» never edits the old row. In one transaction it flips the old
active row to `status = superseded` and creates a **new version** (`version + 1`,
`supersedesSnapshotId`, required `correctionReason`). Double corrections form a sequential version
chain; there are never two parallel active versions. The old versions stay in history and the
balance always uses the latest active version for a date. Rows are never deleted; nothing is
edited destructively.

## Backdated form + timeline (§13/§14)
- The control-balance form allows an **earlier** date (not limited to the latest point) and blocks a
  **future** date. When a later point exists, the UI warns that a new earlier record changes only
  the historical interval before the next point and not the current balance.
- The **timeline** (per club + legal entity) shows every version: effective date, amount, coverage
  interval («с 01.07 до 02.07» / «с 02.07 по настоящее время»), version, status (активна /
  скорректирована), author, comment/reason, and a «Скорректировать» action on active rows. Desktop
  table + mobile cards.

## Migration & preflight (§15)
Additive, non-destructive columns (`status` default `active`, `version` default `1`,
`supersedesSnapshotId`, `correctionReason`) on both dev (sqlite) and prod (postgres) — no sums
recomputed, no rows deleted; legacy rows become base versions. Run
`npm run preflight:balance-snapshots` (read-only) before/after deploy to list same-date active
duplicates, future dates, orphan legal entities, and archived-club snapshots.
