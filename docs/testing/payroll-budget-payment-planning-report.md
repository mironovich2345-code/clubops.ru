# Payroll → Salary Budget → Payment Planning — report

The payroll module is now linked to salary budgets and the payment calendar **without** collapsing
the distinct numbers. Built additively on a mature payroll engine (accrual/payment/advance/remaining/
reversal already existed); this epic added the missing forecast, budget linkage, and payment
obligation, and connected them. No salary formula, `EmployeePayScheme`, closed period, expense,
invoice, refund, cash formula, tenant/multi-account, or existing approval workflow was changed.

## The four numbers, kept separate
1. **A — Прогнозный ФОТ** — `calculatePayrollForecast` from active schemes; read-only; never stored,
   never enters `PaymentObligation[]`, never mutates a budget. Missing scheme / variable part /
   unknown legal entity → warnings + `confidence:"partial"`, never a silent 0.
2. **B — Утверждённый бюджет ЗП** — `Budget{category:"salary"}`; changed **only** via an approved
   `BudgetChangeProposal`. `salaryBudgetSyncMode` default `suggested`; `auto_sync` requires explicit
   opt-in.
3. **C — Начислено** — `PayrollCalculation.grossAccruedKopeks / netPayableKopeks` in an approved
   period (unchanged engine).
4. **D — Выплачено** — `PayrollPayment` + the single salary `Expense` (unchanged engine).
   Remaining = `netPayable − paid`.

## What was added
- **Forecast** (`src/lib/payroll/forecast.ts`) — guaranteed-base per scheme type + variable flag;
  aggregation by club/category/employee/legalEntity; honest warnings.
- **Budget linkage** (`src/lib/payroll/budget-linkage.ts`) — variance (null % when forecast ≤ 0),
  drift decision, RBAC, five-number loader, append-only proposal create/decide.
- **Proposal actions + UI** — `budgets/proposal-actions.ts`, `SalaryBudgetPanel`,
  `SalaryProposalActions`/`PlanningSettingsForm`; owner/GD approve, regional/owner/GD propose.
- **Payment obligation** (`src/lib/payroll/payment-obligation.ts`) — generation from approved
  periods (legalEntity+club+category granularity), remaining recomputed from confirmed payments,
  idempotency-keyed, chief-only append-only cancellation; wired into `buildPayrollObligations()`.
- **Generation hooks** — on period approval and on payment record/cancel (`periods/actions.ts`).
- **Company settings** — `salaryBudgetSyncMode`, `salaryBudgetIncludesTaxes`, `payrollAdvanceDay`,
  `payrollFinalDay`, `payrollWeekendRule`, `payrollTimezone` (all additive/defaulted).
- **Preflight + backfill** — `preflight-payroll-budget-payment-planning.mjs` (10 read-only checks),
  `backfill-payroll-obligations.mjs` (dry-run/--apply, idempotent, no budget change).

## No double count
Calendar has three separate rails — forecast «Ожидаемый ФОТ» (planning only) vs obligation «Зарплата
к выплате» (outstanding remaining) vs actual payment. Advances are folded into `netPayable` once;
obligation `remaining` is clamped ≥ 0; overpayment surfaces as employee debt (existing flow), never
a negative obligation.

## Migrations (additive, non-destructive)
- `20260802120000_salary_budget_change_proposal` (dev + prod) — `BudgetChangeProposal` + Company
  settings columns.
- `20260802130000_payroll_payment_obligation` (dev + prod) — `PayrollPaymentObligation`.
- No drops, no type changes. Dev applied via `migrate deploy`; prod diffed schema-to-schema.

## Tests / build
- `pilot:payroll-budget-payment-planning` — **68/68** (forecast, variance, drift, RBAC, due-date,
  obligation status, no-double-count, chief-only reversal, additive migrations).
- `pilot:full` — **3641/0 across 80 suites**.
- `tsc --noEmit` clean; `prisma validate` dev + prod valid; `build:prod` compiled.

## Roles
Propose budget change: regional/owner/GD. Approve/reject: owner/GD. Pay-schedule + sync settings:
owner/GD. Obligation cancellation: chief_accountant only. Owner/GD not widened; «Реклама — только
ГД» untouched.

## Manual acceptance
See `payroll-budget-payment-planning-checklist.md` — live-data GATE checks (real forecast/budget/
obligation/calendar with real periods, schedules, and payments).
