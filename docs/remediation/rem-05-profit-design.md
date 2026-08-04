# REM-05 — Profit Service Design

`src/lib/finance/profit.ts` — `calculateProfit`.

```
profit = recognizedRevenue − recognizedExpenses
recognizedRevenue = OFD net (income − OFD fiscal returns) for the months
recognizedExpenses = loadRecognizedExpenses(...).totalKopeks
```

## Input / output
- In: `{ companyId, allowedClubIds, months[], clubId?, legalEntityId?, db? }`.
- Out: `{ revenueKopeks, expenseKopeks, profitKopeks, revenueBreakdown{ofdNet,ofdIncome,ofdReturns},
  expenseBreakdown(bySourceType), warnings, formulaVersion }`.

## Revenue (BD-03, §8)
- Canonical = the OFD aggregate the product already treats as official
  (`loadOfdManagementOverview → totals.netKopeks`), summed per month.
- Client Refund records are **NOT** subtracted from revenue — they are a separate recognized
  expense (BD-REFUND). OFD fiscal returns (till-level reversals of OFD sales) DO reduce revenue;
  the reconciliation tool flags any overlap between the two.
- Legacy `Sale`/`SalesReport` are historical/diagnostic and do NOT define official profit.

## Excluded from profit (BD-03)
«Приход Иное», internal transfers, collections, ООО→ИП withdrawals, regional cash transfers,
budget, payroll forecast, payment obligations, cash balances, advances above the accrual, invoice
payments as a second effect. None are read by the service.

## Reader adoption status
The canonical service is built + proven. The existing dashboard/analytics profit cards still read
their legacy Sale/SalesReport (or OFD-toggle) basis; migrating them to `calculateProfit` is the
live gate **G-FIN-1/G-FIN-7** (accountant ratifies a real month; dashboard = analytics = export).
Until then FIN-001/UX-005 are PARTIALLY CLOSED.
