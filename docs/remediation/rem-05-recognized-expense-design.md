# REM-05 — Recognized-Expense Service Design

`src/lib/finance/recognized-expense.ts` — the ONE aggregator every profit / budget-fact /
plan-vs-fact reader uses. Accrual recognition, never cash movement.

## Input
`{ companyId, allowedClubIds, clubId?, legalEntityId?, months[], category?, includeBreakdown?, db? }`

## Output
`{ totalKopeks, bySourceType, byCategory, byClub, byLegalEntity, warnings, formulaVersion, rows? }`

## Source recognition matrix (`recognition.ts`)
| Source | Included when | Amount | Period | Category | sourceType |
|---|---|---|---|---|---|
| Expense | status ∈ `confirmed`,`verified` | `amountKopeks` | `expenseDate` month | `category` | cash_expense / tax / mandatory |
| Invoice | status ∈ approved-unpaid + `partially_paid` + `paid` | FULL `amountKopeks` (never × paid%) | `invoiceExpensePeriod` | `expenseCategory` | invoice / tax |
| Payroll | PayrollPeriod status ∈ approved-or-beyond | `netPayableKopeks` | period year-month | `salary` | payroll_accrual |
| Refund | v1 approved-unpaid+paid · v2 `accounting_in_progress`+`paid` | `refundResultAmountKopeks ?? amountKopeks` | `refundDate??paidAt??createdAt` | `refunds` | refund |
| Tax | Expense/Invoice with a tax category | its amount | its period | its category | tax |

## Deliberately NOT read
InvoicePayment, CashMovement, PayrollPayment, PayrollAdvance, cash transfers, collections,
OtherIncome («Приход Иное»), budgets, forecast, obligations. These are cash movements or
commitments, not recognized expenses — so they can never leak into a total.

## Scope / period
- `clubId` narrows within `allowedClubIds` (tenant + club isolation); empty → 0.
- `legalEntityId` filters every source.
- `months` is the inclusive set of accounting months; each source maps its row to a `YYYY-MM`
  local month key (no UTC drift) and is included iff that key ∈ months.
- Missing category → `unassigned` bucket (still in the total); a warning records the count. Missing
  period → the row's fallback period is used and it never silently vanishes.

## Invariants (proven by `test:rem-05-integration`)
- Σ `byCategory` = `totalKopeks` = Σ `byClub` = Σ `bySourceType`.
- Integer kopeks throughout; no float, no paid-fraction scaling.
- Same rules feed profit and budget fact, so the two can never disagree on what an expense is.
