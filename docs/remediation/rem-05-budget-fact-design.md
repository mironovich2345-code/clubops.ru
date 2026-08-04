# REM-05 — Budget-Fact Service Design

`src/lib/finance/budget-fact.ts` — `calculateBudgetFact`, plus the migrated pure readers in
`budgets.ts`.

```
available = approvedBudget − recognizedFact
approvedBudget = Σ Budget.limitAmountKopeks (scope clubs, month, [category])
recognizedFact = loadRecognizedExpenses({ months:[month], ... }).total
```

## Output
`{ month, approvedBudgetKopeks, recognizedFactKopeks, availableKopeks, varianceKopeks, rows[],
byCategory, warnings, formulaVersion }` — one row per category with a budget OR recognized fact.

## What changed (closes FIN-002 / FIN-003 / DATA-018/019)
The three legacy fact functions disagreed: `computeBudgetFactReport`/`computeBudgetOverruns`
counted confirmed-only expenses + paid-only invoices, dropping v2 `verified` and every
`partially_paid` invoice. All are now aligned to recognition:
- expenses realize `confirmed` + `verified`;
- invoices count in FULL by `expensePeriod` for approved-unpaid + `partially_paid` + `paid`;
- refunds count in their approved-or-paid state.
`getBudgetFactReportForScope` loads those statuses; Plan/Fact, overruns and "Использовано" now
produce the same fact for the same period.

## Committed vs fact (§20)
Committed obligations (approved-unpaid remaining, payroll obligations, mandatory payments) are a
**separate liquidity figure**, never folded into fact. A `partially_paid` invoice is already fully
in fact, so its remaining is shown as an obligation elsewhere, not as extra budget expense — no
double count.

## Invariant (§19)
`Σ (category facts incl. unassigned) = recognizedFact` — guarded in code
(`category_sum_mismatch` warning) and proven by `test:rem-05-integration`.

## Reader adoption status
The pure Plan/Fact readers are migrated. The budgets **page** shows category rows fed pre-loaded
expense/invoice/refund data; payroll accrual appears via the canonical service (category `salary`)
— wiring the page's payroll row is the remaining follow-through (G-FIN-8).
