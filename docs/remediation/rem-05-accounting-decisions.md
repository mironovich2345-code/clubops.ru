# REM-05 — Ratified Accounting Decisions (as implemented)

The business decisions that REM-05 encodes, and exactly how each maps to code in `src/lib/finance/`.

## BD-03 — Official profit
```
profit = OFD revenue (net) − recognized expenses
```
Recognized expenses = confirmed/verified cash expenses + FULL recognized invoice amount by
expensePeriod + approved payroll accrual by payroll period + client refunds (separate) + taxes/
mandatory recorded as real expense records. **Excluded from profit:** «Приход Иное», internal
transfers, collections, ООО→ИП withdrawals, regional cash transfers, budget, payroll forecast,
payment obligations, cash balances, advances (above the accrual), invoice payments (as a 2nd effect).
→ `calculateProfit` (`profit.ts`), `loadRecognizedExpenses` (`recognized-expense.ts`).

## BD-04 — Official budget fact
Budget fact = recognized expenses of the period (accrual), NOT cash-movement dates.
`available = approvedBudget − recognizedFact`. Committed obligations are shown SEPARATELY, never
folded into fact. → `calculateBudgetFact` (`budget-fact.ts`) — same `loadRecognizedExpenses`.

## BD-INVOICE — Partially-paid invoice
Full recognized invoice amount → expense + budget fact + profit, by `expensePeriod`. `InvoicePayment`
rows are cash movement only (reduce remaining; never a 2nd expense; may be in another month).
`partially_paid` does NOT exclude the invoice. → `INVOICE_RECOGNIZED_STATUSES` (approved-unpaid +
`partially_paid` + `paid`); amount is never scaled by paid %.

## BD-REFUND — Refund accounting
A client refund is a SEPARATE recognized expense, one effect, by its approved business date; it does
NOT reduce OFD revenue and creates no parallel Expense row (the Refund is the canonical source).
→ `isRecognizedRefund` (v1: approved-unpaid+paid; v2: accounting_in_progress+paid),
`refundRecognizedAmountKopeks = refundResultAmountKopeks ?? amountKopeks`.

## BD-TAX — Tax model (no engine)
No tax/VAT engine, no rates. VAT is already inside the invoice total (never added on top); a VAT
amount may be stored for reference only. Taxes/contributions are recognized ONLY as real expense/
mandatory records carrying a tax category. → `isTaxCategory`, `TAX_CATEGORIES`; profit/budget use the
invoice TOTAL amount unchanged.

## The four accounting concepts (never mixed by a reader)
| Concept | Example (invoice) | Example (payroll) | Where |
|---|---|---|---|
| A recognized REVENUE | — | — | OFD net |
| B recognized EXPENSE | full invoice amount | approved accrual (netPayable) | `loadRecognizedExpenses` |
| C cash MOVEMENT | InvoicePayment | PayrollPayment / advance | ledgers (NOT here) |
| D obligation | remaining | remaining | payments module (NOT fact) |

## Canonical revenue note
Revenue = OFD **net** (income − OFD fiscal returns), the aggregate the product already treats as
official. OFD fiscal returns are till-level reversals of OFD sales; client Refund records are the
separate recognized expense. The reconciliation tool flags any overlap. Legacy Sale/SalesReport
remain historical/diagnostic and do NOT define official profit.
