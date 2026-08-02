# WAVE 0 — Audit: Payroll → Salary Budget → Payment Planning

Pre-change audit of the current model, ahead of linking the payroll module to salary budgets
and the payment calendar. **No behaviour is changed by this document.** It maps what exists,
what is missing, where truth lives, the formulas already in force, and the concrete risks the
new work must avoid.

Date: 2026-08-02 · Scope: `companyId` + `clubId` (+ `legalEntityId` where present) + period.

---

## 0. Executive summary

The payroll engine is **mature**. Accrual, actual payment, advances, remaining, debt and
reversal are all already modelled and enforced (see [Payroll finance single-source] §8
invariants). The salary **Budget** row exists (`category = "salary"`). The payment-calendar
pipeline already has a **designed, un-built** payroll contract (`buildPayrollObligations()`
placeholder).

So this epic is **not** a rebuild. It fills four genuine gaps, additively:

| # | Gap | Exists today? |
|---|---|---|
| A | **Forecast ФОТ** (future planned payroll cost from active schemes) | ❌ none |
| B | **Budget ↔ forecast linkage** (variance, sync mode, change proposal) | ❌ none |
| C | **Payroll payment obligation** (approved period → calendar «к выплате») | ❌ placeholder only |
| D | **Company settings** (sync mode, pay schedule, taxes-in-budget flag) | ❌ none |

Everything under "accrual / payment / advance / remaining / reversal" (WAVE 4) **already
works** — this epic verifies, documents and connects it, and does **not** rewrite it.

---

## 1. The four distinct numbers (and where truth lives today)

The spec's core demand is to keep four numbers separate. Mapping to the real model:

| # | Number | Truth source (today) | Notes |
|---|---|---|---|
| **A** | Прогнозный ФОТ (forecast) | *nothing yet* — must derive from **active `EmployeePayScheme`** + planned inputs | forward-looking, never stored as fact |
| **B** | Утверждённый бюджет ЗП | `Budget` where `category="salary"` (`limitAmountKopeks`, per `clubId`+`month`) | stored, approved separately; **must not be silently overwritten** |
| **C** | Начислено / к выплате | `PayrollCalculation.grossAccruedKopeks` / `netPayableKopeks` in an **approved** `PayrollPeriod` | per employee+period; already immutable via version snapshots |
| **D** | Фактически выплачено | `PayrollPayment` (+ one salary `Expense{category:"salary"}` + `CashMovement`) | `PayrollCalculation.paidKopeks`; the **single** money record |

**Remaining** already exists: `PayrollCalculation.remainingKopeks`
(`= netPayableKopeks − paidKopeks`, advances already folded into `netPayableKopeks` via
`advancesKopeks`). Debt: `employeeDebtKopeks` / `companyDebtKopeks` + `EmployeeFinancialObligation`.

**Nothing here is torn down.** A ⇒ new. B ⇒ existing row, add read-side linkage + proposal
workflow. C, D ⇒ existing, reused as the obligation source.

---

## 2. Entity map

### Budget side
- **`Budget`** (schema `Budget`): `companyId, clubId, category, month:String, limitAmountKopeks, createdByUserId`; unique `[clubId, category, month]`. Salary budget = rows with `category="salary"` (label «Зарплата», `src/lib/expenses.ts:54`). **No `legalEntityId`, no `year`** — month is a string key. Club-scoped, not legal-entity-scoped.
- **`BudgetApprovalRequest`**: existing budget approval workflow (do **not** disturb; «Реклама — только ГД» rule lives adjacent).

### Payroll side (all mature)
- **`EmployeePayScheme`** — the versioned pay scheme (NOT "PayrollScheme"). Truth source for **forecast** (A). Versioned via `scheme-version.ts`.
- **`PayrollPeriod`** — `companyId, clubId, year:Int, month:Int, status(default "draft"), submittedAt, regionalApprovedAt, accountingApprovedAt, closedAt, version`; unique `[clubId, year, month]`. Statuses progress draft → submitted → regional/accounting-approved → closed. `closedAt`/approval timestamps ⇒ immutability boundary for **obligation generation** (C).
- **`PayrollCalculation`** — per employee+period; unique `[payrollPeriodId, employeeId]`. Carries `legalEntityId?`, `grossAccruedKopeks`, `netPayableKopeks`, `paidKopeks`, `remainingKopeks`, `advancesKopeks`, `employeeDebtKopeks`, `companyDebtKopeks`, `roleSnapshot`, `schemeSnapshotJson`. **This is the accrual truth (C).**
- **`PayrollPayment`** — actual payout: `amountKopeks, paymentDate, paymentMethod(cash|bank), sourceType(club_cash|regional_cash|bank_account), status, legalEntityId?, expenseId(→ salary Expense), cashMovementId, statementId`. **This is the payment truth (D).**
- **`PayrollAdvance` / `PayrollAdvancePayment`** — advances (already reduce remaining via `advancesKopeks`).
- **`EmployeeFinancialObligation`** — employee↔company debt ledger (`obligations.ts`), separate from the payment-calendar obligation.
- **`PayrollChangeRequest`** — existing scheme-change approval workflow.

### Payment-calendar side
- **`src/lib/payment-obligations.ts`** — unified `PaymentObligation` pipeline. `PaymentSourceType = "invoice" | "mandatory_payment" | "payroll"`. **`buildPayrollObligations()` returns `[]`** (designed placeholder, lines 356–406). Types already declared: `PayrollType = "advance" | "final_salary"`, `PayrollStatus = "planned"|"approved"|"paid"|"canceled"`, `PayrollObligation`. `loadPaymentObligationsForScope()` already calls `buildPayrollObligations()` and merges — so **the moment it emits rows, they appear on /payments, upcoming, cash-gap, accountant workspace automatically.**

---

## 3. Formula map (already in force — do not change)

- **Accrual:** `grossAccruedKopeks` (per-category formulas in `src/lib/payroll/formulas.ts` / `compute.ts`) → `netPayableKopeks = gross − deductions − advances (± debt)`. Integer kopeks.
- **Remaining:** `remainingKopeks = netPayableKopeks − paidKopeks`.
- **Advance folding:** `advancesKopeks` reduces `netPayableKopeks` so 100k accrued + 40k advance ⇒ 60k remaining, never 140k. **§16 invariant already satisfied.**
- **Actual expense:** `createSalaryExpense()` (`salary-expense.ts`) makes exactly **one** `Expense{category:"salary"}` + one `CashMovement` via `recordExpenseMovement`; cancellation cancels the Expense and calls `reverseCashOutflow()` (chief-gated). **§17/§18 (single money record, reversal-not-delete) already satisfied.**
- **Expense period vs pay date:** salary Expense drives P&L by its accrual period; `PayrollPayment.paymentDate` is the cash-fact date. Analytics already read by accrual period (the "no double count" boundary). **§26 date invariants already satisfied.**

### New formulas this epic introduces (read-side only, no money mutation)
- `forecastPayroll` = Σ active-scheme projected cost for the target future period (by club/category/legalEntity/employee/paydate).
- `budgetVariance = approvedSalaryBudget − forecastPayroll`.
- `budgetVariancePercent = forecast > 0 ? variance / forecast : null` (null, **not 0**, when forecast is 0/unknown).
- `cashDeficit = availableCashByDueDate − payrollRemaining` (null/«Недостаточно данных» when cash is unknown, **not 0**).

---

## 4. Risk register (what the new work must not do)

| Risk | Where it bites | Mitigation in this epic |
|---|---|---|
| **Silent budget overwrite** | tying forecast → Budget | `salaryBudgetSyncMode` default `suggested`; `auto_sync` only when explicitly set; changes go through append-only `BudgetChangeProposal` |
| **Closed-period recompute** | forecast/scheme change bleeding into approved C | obligation + accrual read only from **approved/closed** periods; scheme change affects **future forecast only**; a `PayrollPeriod` past `regionalApprovedAt`/`closedAt` is never re-derived |
| **Double counting** | calendar showing forecast **and** obligation **and** actual | three distinct rails: forecast «Ожидаемый ФОТ» (planning only) vs obligation «Зарплата к выплате» (`PayrollPaymentObligation`, from approved period) vs actual `PayrollPayment`. Obligation `remainingKopeks` shrinks as payments confirm; forecast never enters `PaymentObligation[]` |
| **Advance double count** | obligation vs advance | obligation amount = `netPayableKopeks` (advances already folded); advance is a payment that reduces obligation remaining, never an added line |
| **Legal-entity mismatch** | cross-entity obligation/payment | obligation carries `legalEntityId` (from the calc); generation scoped by company+club+legalEntity+period; no cross-entity/cross-company links |
| **Missing data → fake zero** | forecast with no scheme; cash unknown | emit **warnings** («Прогноз неполный»), never a silent 0; variance/deficit return `null` + «Недостаточно данных» |
| **Wrong expense date** | payment posted to wrong period | reuse existing `createSalaryExpense` (accrual period) + `paymentDate` split; do not touch |
| **Hardcoded tax rates** | budget-includes-taxes | `salaryBudgetIncludesTaxes` company flag (default off); no rate baked in |
| **Auto-split shared employee** | employee across clubs with no rule | if no allocation rule → company-level "Не распределено по клубам"; never silent even split |
| **RBAC creep** | budget-change approval | regional **proposes**, owner/GD **approve**, accountant/manager **view**; chief-only reversal (existing); do **not** widen owner/GD or touch «Реклама — только ГД» |
| **Duplicate obligation** | re-running generation | `idempotencyKey` (company+club+legalEntity+category+period+dueDate); append-only, upsert-by-key |

---

## 5. Migration plan (additive, non-destructive)

Dev (`prisma/schema.prisma`, sqlite) + prod (`prisma/production/schema.prisma`, postgres via
`scripts/sync-prod-schema.mjs`). `migrate dev` is interactive here → use
`prisma migrate diff --script` + `migrate deploy`. All new tables/columns, **no drops, no
type changes**.

1. **`BudgetChangeProposal`** — `id, companyId, clubId, category, month, currentLimitKopeks, proposedLimitKopeks, reason, sourceType(forecast_drift|manual|scheme_change), status(pending|approved|rejected|superseded), proposedByUserId, decidedByUserId?, decidedAt?, createdAt`. Append-only (status flips, never delete). Indexes: `companyId`, `[clubId, category, month]`, `status`.
2. **`PayrollPaymentObligation`** — `id, companyId, clubId?, legalEntityId, payrollPeriodId, payrollCategory, employeeId?, amountKopeks, paidKopeks(default 0), remainingKopeks, dueDate, status(planned|due|partially_paid|paid|cancelled), sourceCalculationId?, idempotencyKey(unique), cancelledAt?, cancellationReason?, createdAt, updatedAt`. Indexes: `companyId`, `[clubId, dueDate]`, `payrollPeriodId`, `legalEntityId`, `status`.
3. **`PayrollObligationPayment`** — links `PayrollPayment` ↔ obligation (append-only settlement rows) OR reuse `PayrollPayment` + aggregate; **decision: aggregate over existing `PayrollPayment` by period/legalEntity/category** to avoid a parallel ledger (payments already exist). Obligation `paidKopeks`/`remainingKopeks` recomputed from confirmed `PayrollPayment` minus reversals. No new payment ledger.
4. **`Company`** additive columns — `salaryBudgetSyncMode(default "suggested")`, `salaryBudgetIncludesTaxes(default false)`, `payrollAdvanceDay?`, `payrollFinalDay?`, `payrollWeekendRule?`, `payrollTimezone?`. All nullable / defaulted.

No existing column changes. Backfill (WAVE 5) is dry-run/apply, idempotency-keyed, creates **no**
budget change and **no** obligations for draft or fully-paid-without-reconciliation periods.

---

## 6. Wave plan (per §33/§34 — one commit per wave)

- **WAVE 0** (this doc + spec) — audit / entity / formula map. ← *commit 1*
- **WAVE 1** — `calculatePayrollForecast` + missing-data warnings + forecast read UI.
- **WAVE 2** — budget linkage (variance) + `salaryBudgetSyncMode` + `BudgetChangeProposal` + approval RBAC + budget UI.
- **WAVE 3** — `PayrollPaymentObligation` + generation from approved period + wire `buildPayrollObligations()` + schedule settings.
- **WAVE 4** — verify/connect advances, partial payments, reversal, remaining (mostly existing) at the obligation level.
- **WAVE 5** — preflight (read-only checks) + backfill (dry-run/apply) + reconciliation.
- **Then** — `pilot:payroll-budget-payment-planning` + `pilot:full` + gauntlet + docs + report.

**Definition of done:** forecast/budget/accrual/payment separated; salary change → future
forecast only; budget never silently overwritten; approved payroll creates an obligation;
advances/partial payments reduce remaining exactly; reversal audited (chief-only); legal-entity
scope respected; calendar shows no double count; `build:prod` + `pilot:full` green.

---

## References
- [Payroll finance single-source] — §8 money invariants (accrual/payment/advance/debt, cash once).
- `src/lib/payroll/` (28 files), `src/lib/payment-obligations.ts`, `src/lib/expenses.ts:54`.
- Spec: `docs/specs/payroll-budget-payment-planning-spec.md`.
