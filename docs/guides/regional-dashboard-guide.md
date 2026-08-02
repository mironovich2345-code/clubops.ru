# Regional director dashboard — review tasks guide

The regional director dashboard opens with a **«Требуют внимания»** working section: three cards for
objects that need the regional director's action **right now**. It shows only the regional's own
scope; no workflow, status, or out-of-scope calculation is changed.

## The three cards (exact statuses)
| Card | Counts (and only) | Due-date field |
|---|---|---|
| **Счета на проверке** | invoice `status = needs_review` | `dueDate` |
| **Расходы на проверке** | expense (v2) `status = pending_regional_budget_approval` | none → shows task, no overdue |
| **Возвраты на проверке** | refund (v2) `status = pending_regional_review` | `plannedRefundDate` (existing business deadline) |

Single source of truth: `src/lib/regional-tasks.ts`
(`invoiceNeedsRegionalReview` / `expenseNeedsRegionalReview` / `refundNeedsRegionalReview`) — the
same predicates drive the cards, the list filters, and the tests.

## Excluded (NOT a regional task)
- **Invoice:** draft, needs_correction, approved_by_regional / _chief_accountant / _owner (already
  past regional), partially_paid, paid, rejected, canceled.
- **Expense:** draft, submitted, pending_owner_budget_approval, pending_accountant_verification,
  needs_correction, verified, confirmed, cancelled.
- **Refund:** draft, needs_correction, accounting_in_progress, paid, rejected, cancelled, and any v1.

## What each card shows
Count · total sum · overdue badge (only when > 0) · nearest due (or «Без срока») · club count · a
compact per-club breakdown (top 4, then «Ещё N клубов») · «Открыть». Neutral by default; a warning
ring appears only when something is overdue. Empty → «Нет задач на проверке». If a single category
fails to load, that card shows a local error and the rest of the dashboard is unaffected.

## Amounts & overdue
- Amount = the sum of the objects that need the regional's action **only** — never a period total,
  budget, or profit. Integer kopeks (refunds use `refundResultAmountKopeks ?? amountKopeks`).
- Overdue = the due-date field is present AND `< today` (club/company-local day). A missing due date
  is **not** overdue (shown as «Без срока»); expenses have no review deadline (no overdue).
- Refund deadline uses the existing `plannedRefundDate` — the 10-day rule is not recomputed here.

## Scope & security
- Counts/sums are computed **after** the authorization filter: `companyId` + active accessible
  `clubId`s. Archived clubs are excluded. Owner / GD do **not** see this section (regional-only).
- A foreign `clubId` in a URL cannot widen scope — the list loader intersects it with the regional's
  active allowed clubs.

## URL filter contract
Cards and club rows link to a filtered list:
```
/invoices?task=regional_review
/expenses?task=regional_review
/refunds?task=regional_review        (+ &clubId=<id> from a club row)
```
The list page shows an active **«Задачи регионала: на проверке»** chip (+ a club chip when narrowed),
a **«Сбросить фильтр»** reset, and only the regional-task rows (nearest-due first) — all within tenant
scope.
