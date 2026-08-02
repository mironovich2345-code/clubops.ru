# Manual acceptance checklist — regional dashboard review tasks

Run as a **regional director** with access to specific clubs (and, for scope checks, as owner/GD
and as a regional of another company). Static + pilots + build are green; this covers live data.

## Section & cards
- [ ] The dashboard opens with «Требуют внимания» — three cards: Счета / Расходы / Возвраты на проверке.
- [ ] Desktop: three across (or 2+1); mobile: one column, full-width, no horizontal scroll.
- [ ] Each card shows count, total sum, nearest due (or «Без срока»), club count, per-club breakdown
      (top 4 + «Ещё N клубов»), and «Открыть».

## Correct counting  (GATE)
- [ ] Счета counts only `needs_review` invoices in the regional's clubs.
- [ ] Расходы counts only `pending_regional_budget_approval` (v2) expenses.
- [ ] Возвраты counts only `pending_regional_review` (v2) refunds.
- [ ] Draft, already-approved-by-regional, accountant-only, owner-only, paid/verified, and
      rejected/cancelled objects are **not** counted.
- [ ] Sums are exact (kopeks) and match the sum of the objects that need action.

## Overdue & nearest
- [ ] An overdue badge appears only when something is past its due date; otherwise the card is neutral.
- [ ] An object with no due date is shown as «Без срока», not overdue.
- [ ] Nearest due is the earliest present due date.

## Scope  (GATE)
- [ ] Only the regional's accessible clubs appear; a club of another company/regional does not.
- [ ] Archived clubs are excluded.
- [ ] **Owner / GD do not see** the «Требуют внимания» section.
- [ ] Opening `/invoices?task=regional_review&clubId=<foreign>` does **not** reveal foreign data (the
      filter stays within the regional's active clubs).

## Links & list filter
- [ ] «Открыть» opens the filtered list (`?task=regional_review`) with an active chip and «Сбросить фильтр».
- [ ] A club row opens the same list narrowed to that club (a club chip is shown).
- [ ] The list shows only the regional-task rows, nearest-due first; reset returns to the full list.

## Robustness
- [ ] With no tasks, the card shows «Нет задач на проверке» (no zero warning badges).
- [ ] If one category fails to load, that card shows a local error and the rest of the dashboard works.
- [ ] Dark theme is readable; mobile has no horizontal scroll at 320px.

**Sign-off:** accepted when the GATE sections pass on a real instance for a regional director, with
owner/GD confirmed to not see the section and cross-scope confirmed excluded.
