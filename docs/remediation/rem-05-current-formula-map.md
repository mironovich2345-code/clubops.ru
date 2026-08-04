# REM-05 — Current Formula Map (pre-change)

Precise inventory of every profit / budget-fact computation at `71ea1bb`, with revenue/expense/
payroll/refund/invoice/period/scope/consumer/divergence per implementation.

## Profit computations
| # | Path / fn | Revenue | Expense sources | Payroll | Refund | Invoice statuses | Period | Scope | Consumer | Divergence |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `analytics.ts` `summary.profitKopeks` | Sale+SalesReport `total_revenue` | Expense(conf+ver)+paid Invoice+paid Refund | via salary Expense only | in spend | `paid` only | exp:`expenseDate`, inv:`expensePeriod` | company+clubs | analytics summary | **drops partially_paid + payroll accrual** |
| 2 | `analytics.ts` `buildProfitTrend` | Σsales−Σspend/bucket | same | same | same | `paid` | same | company+clubs | built, not rendered | same |
| 3 | `analytics.ts` `clubRanking[].profitKopeks` | per-club sales−spend | same | same | same | `paid` | same | per-club | partial | same |
| 4 | `analytics/page.tsx` `useOfd?ofdResult:profit` | **OFD net** OR Sale basis | same expenses | same | same | `paid` | same | company+clubs | "Финансовый итог" card | **two revenue bases on one card (FIN-001/UX-005)** |
| 5 | `ofd-management.ts` `computeManagementResult` | OFD net | confirmed costs param | — | — | — | window | scope | "Результат (ОФД − расходы)" | costs param varies by caller |
| 6 | `analytics/page.tsx` multi-company | OFD income − expenses | expenses | — | — | — | period | multi-company | strategic mobile card | yet another basis |
| 7-9 | `dashboard.ts` profitSummary/clubComparison/clubRanking | Sale − expenses | ExpenseSummary | — | — | — | — | — | **DEAD CODE (no importer)** | divergent but unwired |

## Budget-fact computations
| Fn | Plan | Expenses | Invoices | Refunds | Period | Scope | Consumer | Divergence |
|---|---|---|---|---|---|---|---|---|
| `computeUsedKopeks` | Σ limit | conf+ver | approved-unpaid + paid | approved+paid | inv `expensePeriod`, exp/refund month | club+cat+month | "Использовано" + `evaluateExpenseBudget` gate | includes committed invoices |
| `computeBudgetOverruns` | Σ limit | **confirmed only** | approved-unpaid + paid | approved+paid | same | scope+month | overrun alerts | drops v2 verified |
| `computeBudgetFactReport` | Σ limit | **confirmed only** | **paid only** | **paid only** | same | scope+month | Plan/Fact + analytics block 7 | drops v2 verified + partially_paid |

## Salary / payroll handling
No profit/budget reader reads `PayrollCalculation.netPayableKopeks`. Labor cost only appears if a
salary-category `Expense` was booked at payment time → understated + inconsistent (FIN-001, Audit 3).

## Refund handling
Single-effect (added to spend / "refunds" category, never a revenue reduction, never an Expense row).
v1 recognized at `paid`; v2 recognized state differs; period source differs across readers (DATA-021).

## Invoice status handling
`partially_paid` is a DERIVED status (`invoice-payments.ts derivedInvoiceStatus`): `0<paid<total`.
It is in the `Invoice.status` column (stored on payment) but sits in NO fact reader's status set
(neither approved-unpaid nor paid) → invisible until fully paid (FIN-002).

## The REM-05 target (one row)
| Concept | Canonical service | Rule |
|---|---|---|
| Recognized expense | `loadRecognizedExpenses` | conf/ver Expense + FULL recognized Invoice by expensePeriod + approved payroll accrual + recognized Refund + tax records |
| Profit | `calculateProfit` | OFD net revenue − recognized expenses |
| Budget fact | `calculateBudgetFact` | approvedBudget − recognized expenses (by category) |
