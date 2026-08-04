# CLUB-OPS — Profit Formulas

Every place profit is computed at `d161c15`, with inputs and the divergences. Money = kopeks.

## Profit computations found
| # | Location | Formula | Wired to a reader? |
|---|---|---|---|
| 1 | `analytics.ts:557` `summary.profitKopeks` | `curSales − curSpend` | **YES — canonical analytics profit** |
| 2 | `analytics.ts:482` `buildProfitTrend` | `Σsales − Σspend` per bucket | built, not currently rendered |
| 3 | `analytics.ts:587` `clubRanking[].profitKopeks` | per-club `sales − spend` | partial (dashboard reads only `expensesKopeks`) |
| 4 | `analytics/page.tsx:433` | `useOfd ? ofdResultKopeks : s.profitKopeks` | **YES — "Финансовый итог" card** |
| 5 | `ofd-management.ts:113` `computeManagementResult` | `ofdNetKopeks − expensesKopeks` | YES — "Результат (ОФД − расходы)" |
| 6 | `analytics/page.tsx:177` (multi-company) | `OFD income − expenses` | YES — strategic mobile card |
| 7 | `dashboard.ts:23` `profitSummary` | `sales − expenses` | **DEAD CODE (no importer)** |
| 8 | `dashboard.ts:105` `clubComparison` | `sales − expenses` | **DEAD CODE** |
| 9 | `dashboard.ts:165` `clubRanking` | `sales − expenses` | **DEAD CODE** |

## Canonical profit inputs (`analytics.ts:557`)
- **Revenue** = `Sale`(`status:confirmed`, `analytics.ts:202`) **+** confirmed `SalesReport` `total_revenue` line (`:203`, folded `:217`). `total_revenue = revenue_ooo + revenue_ip` — **ИП revenue included**.
- **Spend** = `Expense`(`confirmed`+`verified`, by `expenseDate`) **+** paid `Invoice`(`status:paid`, by `expensePeriod`) **+** paid `Refund`(`status:paid`, by `paidAt`, category `refunds`).
- **Refunds** → added to **spend** (not subtracted from revenue). **Single-effect** (FIN-009).
- **Payroll** → **absent** unless a salary-category `Expense` exists (FIN-001).
- **Taxes** → only via an Expense/invoice with category `taxes`.
- **Period** — expenses by `expenseDate`; invoices by `expensePeriod` (accrual); refunds by `paidAt`.
- **v1/v2** — expenses count **both** confirmed(v1)+verified(v2); invoices/refunds by `paid`.
- **Legal entity** — none (profit does not split ООО/ИП).

## Profit-formula comparison (one row per reader)
| Reader | Revenue basis | Spend basis | Payroll | partially_paid invoice |
|---|---|---|---|---|
| analytics.ts:557 (default) | Sale+SalesReport total_revenue | Expense(conf+ver)+paid Invoice(expensePeriod)+paid Refund | only via salary Expense | **excluded** |
| analytics/page.tsx:433 (OFD path, `useOfd`) | **OFD net** (income−returns) | same confirmed expenses | same | excluded |
| dashboard.ts:23 | SaleSummary | ExpenseSummary | — | **DEAD CODE** |

## Findings (feed FIN-001)
1. **Two live profit definitions on the same card** — Sale+SalesReport basis vs OFD-net basis, chosen by `useOfd` (`analytics/page.tsx:433`, `ofd-management.ts:114`). A user with OFD data sees a different profit than one without.
2. **`dashboard.ts` profit trio is dead code** — no importer anywhere; the "analytics vs dashboard profit" divergence exists in source but `dashboard.ts` is unwired.
3. **Payroll is absent from every profit reader** → profit **understates labor cost** (salary only appears if a salary Expense was booked via a PayrollPayment; the accrual never does).
4. **`partially_paid` invoices vanish from profit** (analytics counts `status:paid` only) — FIN-002; the `invoice-payments.ts:1-3` "by expensePeriod (accrual)" claim does not hold for `partially_paid`.
5. **Refund single-effect** (expense only; no revenue reduction; no Expense row) — confirmed; correct as long as that is the intended rule (BD-02).
6. **«Приход Иное» and internal cash movements are NOT in profit** — confirmed correct (BD-10).
7. **v2 verified expenses ARE in profit** (unlike budget-fact) — the profit/budget-fact asymmetry (FIN-003).

**Can profit be trusted?** Only with caveats: it depends on which reader (OFD vs Sale/SalesReport),
it **omits payroll accrual**, and it **drops partially-paid invoices**. The profit definition is a
**business decision** (BD-03) that must be fixed before the number is authoritative.

## Update (REM-05)
BD-03 is ratified and encoded: the ONE official profit = **OFD net revenue − recognized expenses**
via `src/lib/finance/calculateProfit` + `loadRecognizedExpenses` (`recognition.ts`). Recognized
expenses now include the approved payroll accrual (`netPayableKopeks`) and partially_paid invoices in
FULL, and exclude payments/cash/transfers/collections/«Приход Иное»/forecast/obligations. Proven by
`test:rem-05-integration` (31/31) incl. the golden scenario (profit 330,000 ₽). The dashboard/analytics
**profit cards** still read their legacy basis — adopting `calculateProfit` is live gate G-FIN-1/7
(FIN-001/UX-005 PARTIALLY CLOSED). See `docs/remediation/rem-05-final-report.md`.
