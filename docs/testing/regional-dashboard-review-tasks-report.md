# Regional dashboard review tasks — report

A «Требуют внимания» section (3 review-task cards) was added to the regional director dashboard.
No invoice/expense/refund workflow, status, cash formula, budget, payroll, or tenant/multi-account
behavior was changed.

1. **Invoice regional task:** `needs_review`.
2. **Expense regional task:** v2 `pending_regional_budget_approval`.
3. **Refund regional task:** v2 `pending_regional_review`.
4. **Excluded:** draft; final (paid/partially_paid/verified/confirmed); accountant-only
   (pending_accountant_verification / accounting_in_progress); owner-only
   (pending_owner_budget_approval / approved_by_owner); already-regional (approved_by_regional /
   needs_correction); rejected/cancelled; v1 refunds; objects outside the regional's clubs.
5. **Amount:** sum of the objects needing the regional's action only (integer kopeks; refunds use
   `refundResultAmountKopeks ?? amountKopeks`); never a period/budget/profit total.
6. **Overdue:** due-date field present AND `< today` (club/company-local day). Missing due → «Без
   срока», not overdue. Expenses have no review deadline → no overdue.
7. **Nearest due:** the earliest present due date across the card's rows.
8. **Club breakdown:** per-club count/sum/overdue, top 4 shown + «Ещё N клубов»; a club row deep-links
   to the club-filtered list.
9. **Scope:** counts computed after the auth filter — `companyId` + **active** accessible clubs;
   archived + cross-company excluded; owner/GD don't see the section; a URL `clubId` can't widen (it
   is intersected with the regional's active allowed clubs).
10. **Shared predicates:** `src/lib/regional-tasks.ts` — `invoiceNeedsRegionalReview`,
    `expenseNeedsRegionalReview`, `refundNeedsRegionalReview` + `loadRegionalReviewTasks(Scoped)` +
    `loadRegionalTaskList/Panel`. One source of truth for cards, list filters, and tests.
11. **URL filters:** `/{invoices|expenses|refunds}?task=regional_review[&clubId=…]` → an active chip +
    reset + nearest-due-first task rows on the list pages (additive top panel).
12. **Indexes/migrations:** none needed — reads use existing indexes (Invoice `status`+`dueDate`;
    Expense/Refund `status`), and each card loads only its bounded task rows (no N+1, no company-wide
    scan). No schema change.
13. **Tests/build:** `pilot:regional-dashboard-review-tasks` **26/26**; `pilot:full`
    **3573/0 across 79 suites**; tsc clean; prisma dev+prod valid; `build:prod` compiled.
14. **Commit hashes:** see `git log` (audit → shared predicates/loader → dashboard cards → list
    filter panel → pilot/scope-fix → docs).
15. **Manual checks:** see `regional-dashboard-review-tasks-checklist.md`.
