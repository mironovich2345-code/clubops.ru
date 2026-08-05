# REM-05A — Profit Reader Map (before → after)

| Reader | Role | Before (revenue/expense) | After | Consumer |
|---|---|---|---|---|
| Analytics "Финансовый итог" card | owner/GD/regional (financials) | `useOfd? ofdResult : s.profitKopeks` | **`calculateProfit`** (revenue + recognized expenses + profit; cash separate) | `analytics/page.tsx FinancialSummaryCard` |
| Analytics "Результат" KPI | financials | OFD net − `s.expensesKopeks` | **`calculateProfit.profitKopeks`** ("Прибыль (ОФД − признанные расходы)") | `analytics/page.tsx` KpiCard |
| Dashboard club-card "Результат" | owner/GD/regional | OFD net byClub − `s.expensesKopeks` byClub | **OFD net byClub − recognized byClub** (= `calculateProfit({clubId})`) | `ClubCard.tsx` + `dashboard-cards.ts` |
| Network total | owner/GD | Σ card results (legacy) | Σ `calculateProfit({clubId})` = `calculateProfit(scope)` | dashboard |
| `dashboard.ts` profit trio | — | Sale − Expense | **@deprecated, 0 callers** | none (dead) |
| `computeManagementResult` | — | ofdNet − confirmed costs | **@deprecated, 0 callers** | none |

## Equivalence (proven by `test:rem-05a-profit-readers` 12/12)
- club-card result `= OFD net byClub − recognized byClub = calculateProfit({clubId}).profitKopeks`;
- `calculateProfit(scope) = Σ calculateProfit({clubId})` (network reconciles);
- partially_paid invoice in FULL, payroll accrual once, refund once, «Приход Иное»/cash irrelevant,
  tenant isolation, negative profit exact, warnings surfaced.

## Performance
`dashboard-cards.ts` calls `loadRecognizedExpenses` ONCE per company scope (byClub breakdown) — no
per-club service call, no N+1. Analytics calls `calculateProfit` once per scope.

## Period note
Analytics/club cards recognize by accounting month (`period.months`) per BD-03; the OFD revenue window
matches for month-aligned periods. A non-month-aligned custom range recognizes by the months it touches
(accrual), which is the intended official-profit semantics.
