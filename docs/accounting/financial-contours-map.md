# CLUB-OPS — Financial Contours Map

Factual map of the four accounting contours at `d161c15`. Money = integer kopeks. Two legal-entity
types per club: **ООО** and **ИП**. Evidence is file:line.

## 1. Income (доходы)
| Source | Sale? | Money move? | Income for PROFIT? | Recognition date | Canonical model | Legal entity |
|---|---|---|---|---|---|---|
| OFD memberships/PT/group/extra/other | yes | no (fiscal) | yes (OFD path) | receipt day | `OfdReceiptImport`→`OfdDailySalesSummary` | per-KKT LE |
| Sales-report revenue (cash/card/СБП per ООО/ИП) | yes | records money split | yes (default path) | `reportDate` | `SalesReport` `total_revenue` line | ООО+ИП |
| card / acquiring / СБП | component of a sale | bank inflow | via revenue line | reportDate | SalesReportLine `card_*`/`sbp_*` | ООО/ИП |
| «Приход Иное» | **no** | yes (cash top-up) | **NO** (excluded) | operationDate | `CashOtherIncome` (B) + `CashMovement.other_cash_income` (A) | ИП |
| owner / regional money in | no | yes | **NO** | operationDate | «Иное» | ИП |
| internal transfer (ООО→ИП, opening) | no | yes | **NO** | operationDate | `CashWithdrawal` / snapshot | both |

**Verified invariants:** «Приход Иное» and internal movements never reach `salesEvents` → **not in
profit** (confirmed: `CashOtherIncome` is never a `Sale`/`SalesReport` line). One OFD item →
exactly one category (`categorizeItem`, falls through to "other"). Revenue basis differs by reader
(OFD net vs Sale+SalesReport) — see `profit-formulas.md`.

## 2. Expenses (расходы)
| Type | Recognition event | Recognition date | Cash effect | Budget effect | Profit effect |
|---|---|---|---|---|---|
| cash Expense (v2) | verify → `verified` | `expenseDate` | ИП wallet (A) **+** fact (B) — double-write | used (confirmed+verified); fact-report (confirmed-only) | included |
| Invoice (unpaid) | none (obligation only) | — | none | committed (used) only | none until paid |
| Invoice paid | status→`paid` | `expensePeriod` (accrual) | InvoicePayment ledger | fact by expensePeriod | included |
| PayrollCalculation | accrual (liability) | period | none | payroll budget module | **NOT** in profit |
| PayrollPayment | creates salary Expense | `paymentDate`/expenseDate | Expense (B) + CashMovement (A) | as expense | as expense |
| Refund (v2) | status→`paid` | `paidAt` | chosen LE | category `refunds` | added to SPEND (single-effect) |
| tax | as Expense category `taxes` | expenseDate | as expense | category `taxes` | as expense (no tax model) |
| mandatory payment | calendar obligation | dueDate | when paid via expense/invoice | — | via its expense |
| correction/reversal | status flip + compensating row | — | reverses A & B independently | drops from fact | reverses |

## 3. Money movements (движение денег)
| Movement | Contour A (wallet) | Contour B (fact) | Reduces income? |
|---|---|---|---|
| cash ООО in (OFD) | **not written** | + fact ООО | no (it's revenue) |
| cash ИП in (OFD) | not written | + fact ИП | no |
| bank/acquiring | not in cash contours | not in cash contours | no |
| collection (инкассация) | not written | − ООО (pending+approved) | no |
| withdrawal ООО→ИП | not written | − ООО + ИП | no |
| regional transfer | separate table | − ИП (confirmed only) | no |
| regional return | out-of-band «Иное» | + ИП | no |
| payroll payout | wallet outflow (A) | − ИП if ИП (B) | no |

## 4. Managerial accounting (управленческий учёт)
| Number | Canonical | Competing sources | Doc |
|---|---|---|---|
| budget limit | `Budget.limitAmountKopeks` | — | `budget-fact-model.md` |
| budget fact | `computeBudgetFactReport` | ⚠3 (used / overruns / fact-report) | `budget-fact-model.md` |
| profit | `analytics.ts:557` | ⚠2 (+OFD path; dashboard.ts dead) | `profit-formulas.md` |
| obligations / debt | `EmployeeFinancialObligation` | ⚠3 debt notions | Audit-2 §14 |
| liquidity forecast | `forecast.ts` / `payment-obligations.ts` | — | Audit-1 |

**Contour reader summary:** every financial screen reads contour **B** (`calculateCashBalances`);
contour **A** (`CashWallet`/`CashMovement`) is still **written** by cash expense + payroll payout but
is no longer read on the ИП cash page, receives no OFD income, and is confirmed-only — so it silently
diverges from B with no reconciliation code. Canonical contour = **B** (business decision BD-09).

> Recognition timing → `accounting-recognition-matrix.md`. Cash formulas + divergence →
> `cash-dual-contour-impact.md`. Rounding → `math-and-rounding-map.md`. Open questions →
> `business-decisions-required.md`.
