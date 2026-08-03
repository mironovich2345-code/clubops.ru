# CLUB-OPS — Financial Source-of-Truth Matrix

Which model/field/formula is canonical for each financial number, and where **more than one
source exists** (the key output). Commit `66bc9e3`. `⚠N` = N competing sources.

## Source-of-truth matrix
| Number | Canonical | Formula (file:line) | Competing sources | Divergence |
|---|---|---|---|---|
| OFD revenue | `OfdDailySalesSummary` | `net = income − return` recomputed from `OfdReceiptImport` (`importer.ts:358`) | raw receipts are the ledger; summary is a **recompute-gated cache** | drift only if recompute skipped |
| **Cash ООО** | *contested* | — | **⚠3:** (1) `BalanceSnapshot.actualBalanceKopeks` (checkpoint); (2) `calculateCashBalances().cashOooFactBalance` (`cash-balances.ts:158`); (3) `analytics.ts:536` report-derived `Σ(cash_ooo − encashment)` | **HIGH** — dashboard card shows (1) `oooKopeks` and (2) `oooFactKopeks` **side-by-side** (`dashboard-cards.ts:95,116`) |
| **Cash ИП** | *contested* | — | **⚠2:** fact `calculateCashBalances().cashIpFactBalance` (contour B) vs `walletBalanceKopeks(club_cash)` = Σ confirmed CashMovement (contour A, `cash-wallets.ts:59`) | **HIGH** — structurally can't reconcile (different inputs/status semantics) |
| Actual/fact cash | `calculateCashBalances` (`cash-balances.ts:128`) | pending already moves balance | `DailyCashReconciliation.actualCashBalanceKopeks` is a frozen attestation | reconciliation snapshot can drift from live recompute |
| Control balance | `BalanceSnapshot` (active, versioned) | latest active ≤ date (`cash-collections.ts:37`) | dashboard/scope readers (`balance-snapshots.ts:23`) **omit the active filter** | MEDIUM — readers disagree which rows are canonical (ARCH-001) |
| «Приход Иное» | *split* | — | **⚠2:** `CashOtherIncome` table (contour B) vs `CashMovement.other_cash_income` (contour A) | **HIGH** — two features on two pages, two tables |
| Collection (инкассация) | `CashCollection` | reduces ООО pending+approved (`cash-balances.ts:154`) | — | 1 |
| ООО→ИП withdrawal | `CashWithdrawal` | −ООО +ИП (`cash-balances.ts:138,156`) | — | 1 |
| Regional transfer | `CashRegionalTransfer` | −ИП only when `confirmed` (`cash-balances.ts:41`) | vs legacy `CashMovement.internal_transfer` regional wallet (unrelated) | 1 (canonical) |
| Cash expense | *double-write* | Expense row → fact (`cash-balances.ts:141`) **and** `CashMovement.expense` → wallet (`cash-wallets.ts:132`) | both contours | **HIGH** — guaranteed ИП wallet↔fact drift (DATA-002) |
| Invoice expense (accrual) | `Invoice.expensePeriod` | realized set differs by consumer | — | 1 accrual; "realized" defined 2 ways (budget) |
| Invoice amount | `Invoice.amountKopeks` | stored | — | 1 |
| Invoice paid | derived `Σ confirmed InvoicePayment` | `invoice-payments.ts:15` | `Invoice.status`/`paidAt` are caches | 1 (ledger); status cache can drift (DATA-005/006) |
| Invoice remaining | `amount − paidTotal` | `invoice-payments.ts:19` | — | 1 |
| Refund amount | `Refund.amountKopeks` | realized when `paid` | v2 also has `refundResultAmountKopeks` | LOW — two amount notions on v2 |
| **Profit** | *contested* | — | **⚠2:** `analytics.ts:557` (sales − spend, invoices/refunds folded) vs `dashboard.ts:23` (SaleSummary − ExpenseSummary, different spend def) | MEDIUM — dashboard profit ≠ analytics profit |
| Budget limit | `Budget.limitAmountKopeks` | unique (club,category,month) | — | 1 |
| **Budget fact** | *contested* | — | **⚠2:** `computeUsedKopeks` (approved-unpaid + paid) vs `computeBudgetFactReport` (paid-only) (`budgets.ts:76` vs `:305`) | MEDIUM — two "fact" numbers same page family |
| Payroll forecast | `calculatePayrollForecast` | derived, never stored | — | 1 |
| Payroll accrual | `PayrollCalculation.grossAccruedKopeks` | `aggregate.ts:53`; **net == gross, no withholding** (`calc.ts:275`) | — | 1 (cache) |
| Payroll paid | `PayrollCalculation.paidKopeks` | Σ confirmed PayrollPayment + active tranches (`aggregate.ts:50`) | ledger is truth; field is a **recompute-gated cache** | drift if recompute skipped (DATA-015) |
| Payroll remaining | `remainingKopeks = netPayable − paid` | `aggregate.ts:70` | **also** `PayrollPaymentObligation.remainingKopeks` (double cache) | obligation lags calc (DATA-016) |
| Payment obligation | `PayrollPaymentObligation` (persisted) + `PaymentObligation` (in-memory calendar) | two notions | payroll remaining lives in **both** calc and obligation | 2 caches |
| Mandatory payment | `MandatoryPaymentPlan` | expanded to calendar | — | 1 |
| **Debt** | *contested* | — | **⚠3:** `EmployeeFinancialObligation.outstandingAmountKopeks` vs `PayrollCalculation.employeeDebtKopeks/companyDebtKopeks` vs analytics network debt (approved-unpaid invoices+refunds) | MEDIUM — three things called "debt" |
| Advance | `PayrollAdvance` + tranches | Σ active tranches (`aggregate.ts:41`) | cash effect also an Expense+CashMovement (contour A) | 1 record; double-contour cash effect |

**Numbers with >1 canonical source: cash ООО (3), cash ИП (2), «Иное» (2), profit (2), budget
fact (2), debt (3), payroll remaining (2 caches), refund amount (2 notions) — 8 numbers.**

## Stored-vs-derived duplicate fields (cache/legacy/must-reconcile)
| Stored field | Truth | Class | Drift trigger |
|---|---|---|---|
| `Invoice.status` | `derivedInvoiceStatus(paidTotal,total,prePaymentStatus)` | cache | status set without recompute; ledgerless `pay` |
| `Invoice.paidAt` | last `InvoicePayment.paymentDate` | cache/legacy | partial payments have many dates, one `paidAt` |
| `PayrollCalculation.paidKopeks/remainingKopeks/gross/net/debt` | `recomputeCalculationTotals` fold | cache | any input change without recompute |
| `PayrollCalculation.employeeDebtKopeks` | over/underpay | cache **and duplicate** of `EmployeeFinancialObligation` | two debt stores disagree |
| `PayrollPaymentObligation.{amount,paid,remaining}Kopeks` | re-derived from calc at generation | **2nd-order cache** | only refreshed on regenerate; `refreshPeriodObligations` errors swallowed |
| `BalanceSnapshot.actualBalanceKopeks` | manual attestation | canonical, competes with legacy wallet | contour A/B split |
| `DailyCashReconciliation.expected/actual/difference` | expected pulled live at submit, then frozen | cache/attestation | live fact keeps moving |
| Budget fact | `computeUsedKopeks` vs `computeBudgetFactReport` | **inconsistent (two derivations)** | both live; report different "fact" |
| `OfdDailySalesSummary` | recomputed from receipts | cache | recompute skipped |
| Contour-A «Иное» vs contour-B `CashOtherIncome` | independent stores | **duplicate/inconsistent** | never reconciled |

## Basis-point rounding divergence (payroll engines)
Two calc engines round money differently: **legacy** `applyBp = ceilToRubleKopeks(Math.round(k*bp/BP))`
(`calc.ts:17` — double round + ceil-to-ruble) vs **v2 role engine** `Math.round(k*bp/BP)`
(`formulas.ts:34` — single round-to-kopeck, no ruble ceil), with component-wise rounding summed
(`formulas.ts:247`). Same economic input can yield ±1 kopeck / ±1 ruble differences depending on
which engine ran. Recorded as DATA-018-adjacent.

> See `cash-contours-reconciliation.md` for the ИП/ООО double-write deep dive and
> `invoice-payment-paths.md` for the ledgerless-paid path.
