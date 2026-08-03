# FULL AUDIT 3/6 — Accounting Model, Financial Flows, Formulas (Findings)

Commit `d161c15`. Read-only; **no formula, status, schema, or data changed.** Evidence is file:line.
Severity S0→S3; confidence proven / likely / needs-live-verification; release blocker yes/no/conditional.
Priorities in `docs/release/remediation-backlog-after-audit-03.md`. Supporting docs: `docs/accounting/*`,
`docs/audits/data/{financial-number-map,formula-matrix,business-decisions,reconciliation-report}.json`.
This is audit **#3 of 6** — the accounting layer under Audit-1 (ARCH) and Audit-2 (DATA).

## Severity roll-up
| Severity | Count | IDs |
|---|---|---|
| **S1 high** | 7 | FIN-001, 002, 003, 004, 005, 006, 012 |
| **S2 medium** | 9 | FIN-007, 008, 009, 010, 011, 013, 014, 015, 016 |
| **S3 low** | 1 | FIN-017 |
| **S0 critical** | 0 | (several S1 are conditional on production data / a business decision) |

**Competing definitions: 8** (profit ×2, budget-fact ×3, cash ООО ×3, cash ИП ×2, debt ×3, «Иное» ×2,
payroll-remaining ×2, rounding-engine ×2). **14 business decisions required** (`business-decisions-required.md`).
**Dev reconciliation:** 1 violation (payroll calc net ≠ paid+remaining, REC-PR-1). **Production unverified.**

---

## FIN-001 — Profit has two live definitions and omits payroll
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional · **BD-03**
- **Evidence:** default profit `analytics.ts:557` (Sale+SalesReport revenue − spend) vs OFD path `analytics/page.tsx:433` → `ofd-management.ts:114` (OFD net − expenses), chosen by `useOfd` on the **same card**. Payroll accrual is in **no** profit reader (only a salary Expense, if booked, appears). `dashboard.ts:23/105/165` profit trio is **dead code** (no importer).
- **Money impact:** owner sees a different profit depending on OFD availability; profit **understates labor cost**.
- **Remediation:** one profit definition (BD-03); include payroll cost; retire dead `dashboard.ts` profit. **P1.**

## FIN-002 — `partially_paid` invoices vanish from profit and all budget-fact readers
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional · **ARCH-008 / DATA-006**
- **Evidence:** analytics counts invoices `status:"paid"` only (`analytics.ts:205`); budget functions count paid or approved-unpaid — `partially_paid` is in **neither** (`budgets.ts:91,310`). Yet it appears in the payment calendar (`payments.ts:9`).
- **Money impact:** a partially-paid invoice's expense is invisible to P&L and budget until fully paid → understated spend; inconsistent vs the calendar.
- **Remediation:** declare `partially_paid`; count the paid portion (or the accrual) consistently. **P1.**

## FIN-003 — Budget fact has three definitions; v2 verified expenses dropped
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional · **DATA-018/019 / BD-04**
- **Evidence:** `computeUsedKopeks` (confirmed+verified, approved+paid) vs `computeBudgetOverruns` (confirmed-only) vs `computeBudgetFactReport` (confirmed-only, paid-only) — `budgets.ts:98/182/306`. v2 verified expenses are in "Использовано"/analytics but **excluded** from Plan/Fact + overruns. `getBudgetFactReportForScope:355` even loads verified rows that `computeBudgetFactReport` discards (FIN-017).
- **Money impact:** overrun decisions made on a fact that omits real verified spend; same period shows different fact numbers.
- **Remediation:** one budget-fact definition (BD-04); include verified. **P1.**

## FIN-004 — Cash ООО/ИП have competing figures; dual-contour double-write; no reconciliation
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional · **ARCH-006 / DATA-001/002 / BD-09**
- **Evidence:** ООО ⚠3 (`cashOooFactBalance` vs `getLatestBalancesByClub.oooKopeks` vs `analytics.ts:536` report-derived); ИП ⚠2 (fact B vs wallet A `cash-wallets.ts:59`). Cash expense + payroll payout double-write both contours (`cash-balances.ts:141` + `cash-wallets.ts:132`). Synthetic divergence 40 000 ₽ (`cash-dual-contour-impact.md`). **No ООО cash-expense term** in the fact formula (FIN-016).
- **Money impact:** the same "остаток наличных" reads different numbers per screen; A and B diverge by construction.
- **Remediation:** one cash resolver + collapse to contour B (BD-09); requires data audit + migration. **P0/P1.**

## FIN-005 — Double salary payment produces a double expense (no idempotency)
- **Severity:** S1 · **Confidence:** proven · **Blocker:** yes (conditional on real payouts) · **ARCH-002 / DATA-003**
- **Evidence:** `PayrollPayment` has no `idempotencyKey`; a retry makes a new Expense (distinct id → distinct `CashMovement.sourceId`, so the movement unique doesn't dedupe). `periods/actions.ts:735`.
- **Money impact:** double-click = **double расход + double cash deduction**, and `paidKopeks` counts both.
- **Remediation:** idempotency key + transaction (ARCH-002). **P0.**

## FIN-006 — Ledgerless paid invoice recognizes an expense with no payment
- **Severity:** S1 · **Confidence:** needs-live-verification · **Blocker:** conditional · **ARCH-010 / DATA-005**
- **Evidence:** legacy `pay` action sets `status:"paid"` with no `InvoicePayment` (`invoices/actions.ts:1278`); analytics then counts it as expense by `expensePeriod` while `paidTotal=0`. `invoice.amount == paid + remaining` fails (REC-INV-1).
- **Money impact:** expense recognized, cash never recorded as moved; status contradicts the ledger.
- **Remediation:** verify UI; retire/convert the legacy pay. **P1.**

## FIN-007 — No tax/VAT accounting model
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no · **BD-05/BD-13**
- **Evidence:** no VAT/УСН/tax-liability model; VAT is folded into `Invoice.amountKopeks` (only an AI guard avoids mis-picking a VAT line, `invoice-quality.ts:87`); `taxes` is merely an expense category (`expenses.ts:53`, cash-forbidden). No tax due dates in the calendar.
- **Money impact:** tax reporting is entirely manual/out-of-model; ФОТ-with-taxes undefined.
- **Remediation:** BUSINESS DECISION (BD-13) before any tax feature; do not invent rates. **P1/P2.**

## FIN-008 — Two payroll rounding engines round the same value differently
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no · **BD (rounding)**
- **Evidence:** engine 1 `applyBp = ceilToRubleKopeks(Math.round(k·bp/BP))` (`calc.ts:17`, ceil-to-ruble) vs engine 2 `pct = Math.round(k·bp/BP)` (`formulas.ts:34`, kopeck round, component-wise summed); manager plan-fact uses two different adjustment formulas + rounding. Both live (calc.ts non-role, formulas.ts role_*).
- **Money impact:** the same accrual differs by ±1 ₽/component depending on scheme type; two employees on equivalent terms can be paid differently.
- **Remediation:** unify the rounding rule across engines (confirmed policy). **P1/P2.**

## FIN-009 — Refund single-effect — confirm it is the intended rule
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no · **BD-02 / DATA-020/021**
- **Evidence:** refund = separate expense (category `refunds`), not a revenue reduction, **no** Expense row (`refund-document-actions.ts:668,729`, `analytics.ts:269`, `budgets.ts:314`). v1 counts approved-unpaid; v2 only paid → committed-vs-realized asymmetry; refund month bucketing differs between budget functions.
- **Money impact:** correct as a single effect, but the treatment and the v1/v2 asymmetry need accountant confirmation.
- **Remediation:** ratify BD-02; align v1/v2 stage + refund date basis. **P2.**

## FIN-010 — Sale + SalesReport both feed analytics revenue (double-count risk)
- **Severity:** S2 · **Confidence:** needs-live-verification · **Blocker:** conditional · **BD-14**
- **Evidence:** revenue = `Sale`(confirmed) + `SalesReport.total_revenue`(confirmed) (`analytics.ts:202-203,217`). Manual sales are disabled (`disabled-features.ts:12`, "продажи из ОФД"), but both `Sale` and `SalesReport` models still exist and feed `salesEvents`. If OFD-sourced `Sale` rows and manager `SalesReport` revenue overlap for a period → **double-counted revenue**.
- **Money impact:** overstated revenue/profit if both populated.
- **Remediation:** confirm the source of `Sale` vs `SalesReport` and that they never overlap (BD-14); run `audit:financial-reconciliation` on prod. **P1.**

## FIN-011 — «Приход Иное» split across two tables/contours
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no · **DATA-004**
- **Evidence:** `CashOtherIncome` (B) vs `CashMovement.other_cash_income` (A). Correctly excluded from profit (BD-10), but the two ИП cash figures diverge. **Remediation:** converge on `CashOtherIncome`. **P2.**

## FIN-012 — Payroll obligation "к выплате" can lag the calc (swallowed refresh)
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional · **DATA-016 / ARCH-002**
- **Evidence:** `PayrollPaymentObligation.{paid,remaining}` refreshed only via best-effort `refreshPeriodObligations` whose errors are swallowed (`periods/actions.ts:42-48,771,807`). **Money impact:** the payment calendar "Зарплата к выплате" can show a stale remaining after a payment/cancel. **Remediation:** fold refresh into the payment transaction. **P1.**

## FIN-013 — PayrollCalculation cache can drift from its own equation
- **Severity:** S2 · **Confidence:** proven (dev has 1) · **Blocker:** conditional
- **Evidence:** `netPayableKopeks == paidKopeks + remainingKopeks` violated by **1 dev row** (REC-PR-1); recompute-gated cache. **Remediation:** reconcile on read or add a recompute guard; run REC-PR-1 on prod. **P1.**

## FIN-014 — Legal-entity attribution is ambiguous across flows
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no · **BD-06/07/11 / DATA-010**
- **Evidence:** refund paid from a chosen LE not tied to the original sale's entity (`refund-document-actions.ts:688`); regional expense filed to the source club; `EmployeeFinancialObligation.employeeId` may hold a `RegionalCityPayroll.id` (DATA-010). **Money impact:** club/entity cost attribution not accountant-confirmed. **Remediation:** ratify BD-06/07/11; fix DATA-010. **P1.**

## FIN-015 — Mixed recognition dates + period drift
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no · **BD-01/12 / DATA-021/022**
- **Evidence:** expense by `expenseDate`, invoice by `expensePeriod`, refund by `paidAt`; refund month differs between budget functions; UTC day-truncation drift (`collections/actions.ts:99`); a backdated correction can change a closed report. **Remediation:** one fact-date policy (BD-12); local-date formatting. **P2.**

## FIN-016 — ООО cash expense has no term in the fact formula
- **Severity:** S2 · **Confidence:** proven · **Blocker:** conditional
- **Evidence:** `cashOooFactBalance` (`cash-balances.ts:158`) deducts only collections + withdrawals — **no expense term**; only ИП cash expenses are deducted (`:141`). **Money impact:** a cash expense on the ООО entity is invisible to the ООО balance. **Remediation:** confirm whether ООО pays cash expenses; if so, add the term. **P1.**

## FIN-017 — `getBudgetFactReportForScope` loads verified expenses it then discards
- **Severity:** S3 · **Confidence:** proven · **Blocker:** no · **Evidence:** loads `confirmed+verified` (`budgets.ts:355`) but `computeBudgetFactReport` filters `confirmed` only (`:306`) — wasted load + latent trap. **Remediation:** align the query with the filter. **P2.**

## What is sound (explicitly)
- **No double count invoice↔analytics** (accrual by `expensePeriod`, never reads the payment ledger).
- **Payroll accrual is a liability, not P&L** (only the salary Expense is the expense) — no accrual+payment double expense.
- **Refund is single-effect** (expense only; no revenue reduction; no Expense row).
- **«Приход Иное» + internal movements excluded from profit** (correct).
- **Money math is numerically safe** (integer kopeks, guards everywhere, no float storage).
- **Reconciliation equations mostly hold in dev** (1 payroll-cache violation).
