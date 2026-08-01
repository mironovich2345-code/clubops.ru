# Regional director dashboard — review tasks — pre-change audit

Read-only survey before adding a «Требуют внимания» section (invoices / expenses / refunds awaiting
the regional director's action). No workflow, status, or out-of-scope calculation changes.

## Current dashboard
- `dashboard/page.tsx` renders a **strategic** view for `isStrategicRole` (owner / GD / **regional**).
  There is no dedicated regional task block today. Existing cards: scope filter, KPI/OFD, club cards,
  cash summary — none show a per-object review queue.
- No reusable "accountant task card" component exists to lift wholesale; the review section is new
  but uses the existing design system (density cards, `formatKopeks`, MonthNav patterns).

## Statuses that ARE a regional task (next required action = regional director)
| Type | Regional-task status | Due-date field |
|---|---|---|
| **Invoice** | `needs_review` | `dueDate` (payment/agreed due) |
| **Expense** (v2) | `pending_regional_budget_approval` | none (no review deadline → show task age, never "overdue") |
| **Refund** (v2) | `pending_regional_review` | `plannedRefundDate` (existing business-rule deadline) |

The refund queue predicate already exists in `refunds/page.tsx`
(`entryVersion === 2 && status === "pending_regional_review"`) — reused, not re-defined.

## Statuses that are NOT a regional task (excluded)
- **Invoice:** draft, needs_correction (back to author), approved_by_regional / approved_by_chief_accountant
  / approved_by_owner (already past regional), partially_paid, paid, rejected, canceled.
- **Expense:** draft, submitted, pending_owner_budget_approval, pending_accountant_verification,
  needs_correction, verified, confirmed, cancelled.
- **Refund:** draft, needs_correction (manager), accounting_in_progress (accountant), paid, rejected,
  cancelled, and any v1 legacy refund.

## Amounts that are safe to show (regional scope only)
- Invoice: `amountKopeks` of the needs_review invoices in the regional's clubs.
- Expense: `amountKopeks` of the pending_regional_budget_approval expenses (v2 cash).
- Refund: `refundResultAmountKopeks ?? amountKopeks` of the pending_regional_review refunds.
- Never a period total, budget, or profit. Integer kopeks only.

## Scope / access
- `getCurrentAccessContext` gives `selectedCompanyId` + `allowedClubIds`. Counts/sums are computed
  **after** scoping by `companyId` + `clubId IN allowedClubIds`. Archived (inactive) clubs are
  excluded from the working set. A foreign `clubId` in a URL cannot widen scope (the list re-checks
  `allowedClubIds`). An inactive regional never reaches the page (page-access gate).

## Loaders / API needed
- New **shared predicates + a scoped counts loader** (`src/lib/regional-tasks.ts`): per type
  count / sum / overdueCount / nearestDue + a per-club breakdown, using `groupBy`/`aggregate`
  (no full row load, no N+1). Single source of truth reused by the dashboard cards, the list
  filters, and the tests.

## List pages & filters
- `invoices/page.tsx` reads `{year, month, city, clubId}` — needs a `task=regional_review` filter.
- `expenses/page.tsx` already has a `status` filter — add `task=regional_review` → the
  `pending_regional_budget_approval` bucket.
- `refunds/page.tsx` already computes a `regionalQueue` — add the `task=regional_review` filter for
  a direct-linked filtered view + a chip + reset.

## Overdue / nearest-due
- Overdue = due-date field present AND `< today` (club/company timezone via day-start). Missing due
  date → NOT overdue, shown as «Без срока». Expenses have no review deadline → no overdue, show age.
- Refund deadline uses the existing `plannedRefundDate`; the 10-day rule is NOT recomputed here.

## Migration / indexes
- Additive indexes only if needed (`companyId, clubId, status, dueDate`) — Invoice already indexes
  `status` + `dueDate`; Refund/Expense index `status`. No schema change expected; if added, additive.
