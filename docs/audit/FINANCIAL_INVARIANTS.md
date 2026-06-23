# CLUB-OPS — Financial Invariants

All money is stored and computed as **integer kopeks** (`amountKopeks: Int`); no floating-point money. Verified across analytics, balance, payments, budgets, sales-reports.

## Source-of-truth formulas

### Spend (analytics / drilldown) — `analytics.ts spendEvents`, `expense-drilldown.ts`
`spend = confirmed expenses (by expenseDate) + paid invoices (by accounting month = expensePeriod via invoiceAnalyticsDate) + paid refunds (by refund/paid date)`.
- Each source enters **exactly once**; invoices use their accounting month (`expensePeriod`), not the payment timestamp, avoiding timezone month-shift.
- Statuses summed: expenses `confirmed`; invoices `paid`; refunds `paid`. Draft/rejected/canceled excluded.

### Debt / cash-gap obligations (dashboard) — `analytics.ts debtKopeks`
`debt = Σ invoice.amountKopeks + Σ refund.amountKopeks` where `status ∈ APPROVED_UNPAID_STATUSES`.
**APPROVED_UNPAID_STATUSES = [approved_by_regional, approved_by_chief_accountant, approved_by_owner]** (canonical, `approval.ts`). Paid is excluded (it is already spend); draft/rejected excluded.

### Budget "used" — `budgets.ts computeUsedKopeks`
`used(club, category, month) = Σ invoice (status ∈ APPROVED_UNPAID_STATUSES ∪ {paid}, expensePeriod==month) + Σ confirmed expense (expenseDate in month) + (category==refunds ? Σ refund (status ∈ same set, in month) : 0)`.

### Balances / cash-gap — `balance.ts`, `balance-snapshots.ts`
ООО and ИП balances are computed and displayed **separately**; never summed across legal entities into a single "available" figure, and never merged across Companies. Multi-Company analytics requires selecting one Company before balances/forecast render.

### Sales — `sales-reports.ts`, `sales-report-rows.ts`
Confirmed report facts split by direction (общий / абонементы / персональные); ИП revenue is folded into personal-training per the existing rule (unchanged by this audit).

## Invariant checklist

| # | Invariant | Status | Note |
|---|---|---|---|
| 1 | Rejected/canceled excluded | ✓ | status filters |
| 2 | Drafts excluded where required | ✓ | spend/debt exclude draft/needs_review |
| 3 | Paid invoice enters expenses once | ✓ | only `status:"paid"` summed as spend |
| 4 | Paid refund enters once | ✓ | only `status:"paid"` |
| 5 | Confirmed expense enters once | ✓ | `status:"confirmed"` |
| 6 | Status change cannot double count | ✓ | spend vs debt are disjoint status sets (paid vs approved-unpaid) |
| 7 | No timezone month misassignment | ✓ | invoices by `expensePeriod`; local-midnight month bounds; Excel import normalized to local midnight |
| 8 | Money is integer kopeks | ✓ | no float |
| 9 | Rounding consistent | ✓ | kopek integers; display ÷100 |
| 10 | Negative/zero handled | ✓ | aggregates tolerate 0; refunds reduce category budget intentionally |
| 11 | Closed-month immutability | ✓ (server) | month-close blocks mutations server-side (transition guards) — recommend a live closed-month rejection test |
| 12 | Aggregate == detail | ✓ | drilldown carries the same status/date/scope filters as the card |
| 13 | Company/city/Club filters consistent | ✓ | all queries scoped to accessible clubs |
| 14 | Historical reports don't use current balances | ✓ | per-month bounds; balances are per-Company snapshots |
| 15 | Companies never mixed | ✓ | every aggregate filtered by `companyId` + accessible clubs |

## F-001 — fixed defect (P1)

**Before:** `budgets.APPROVED_INVOICE_STATUSES`/`APPROVED_REFUND_STATUSES` and `analytics.APPROVED_UNPAID` were `[approved_by_regional, approved_by_owner(, paid)]` — **omitting `approved_by_chief_accountant`**, a real approved-but-unpaid state reached when a club has no active regional director (the chief-accountant fallback). Effect: budget "used" and dashboard debt/cash-gap **undercounted** committed obligations → a budget could be silently exceeded and the cash-gap understated.

**Fix:** introduced canonical `APPROVED_UNPAID_STATUSES` in `approval.ts` (= the `APPROVAL_PAYABLE` set) and sourced both `budgets.ts` (∪ `paid`) and `analytics.ts` from it, so the three sites can never drift from the approval workflow.

**Regression:** `npm run pilot:financial` (6 checks) seeds invoices/refunds across all statuses and asserts: chief-approved is counted in budget-used and in debt; draft/rejected/needs_review excluded; paid excluded from debt; refund debt counts chief-approved only.

## Recommended follow-ups (non-blocking)

- Add a deterministic end-to-end fixture that calls the real `computeUsedKopeks`/analytics loaders (TS) via a test runner, not just the DB status-set boundary, for full formula coverage (P3).
- Add an explicit "closed month rejects mutation" integration check (P2/P3).
