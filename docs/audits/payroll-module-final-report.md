# Payroll (ФОТ) module — final report (§15)

A full payroll/зарплата module for CLUB-OPS, built in 8 staged commits on top of the
existing finance contour. Additive throughout: no existing entity was repurposed, no
working data touched, no destructive migration. See
[`payroll-module-audit.md`](payroll-module-audit.md) for the Stage-1 audit and design,
and [`../testing/payroll-pilot-scenarios.md`](../testing/payroll-pilot-scenarios.md)
for the one-club pilot.

## 1. What was implemented (by stage)

1. **Foundation** — audit, data model (8 additive scalar-id tables + 4 nullable
   ClubEmployee columns), dual migrations, enums, scheme validators (no `eval`), the
   pure calculation engine, and the period status machine.
2. **Setup** — employees, many-to-many club assignments, and historical effective-dated
   pay schemes (changing pay never recomputes a closed month).
3. **Calculations** — per-club-per-month `PayrollPeriod` with one `PayrollCalculation`
   per employee, wired to the engine, with a per-employee breakdown (расшифровка) and a
   frozen scheme snapshot.
4. **Workflow** — manager → regional → accountant approval with role gating, lock after
   approval, and comment-required adjustments (bonus/penalty/correction).
5. **Advances & payments** — partial / cash / bank payouts; cash reduces the club or
   regional wallet exactly once through the existing `CashMovement` ledger; cancellation
   posts a compensating inflow. Statement/document attachable.
6. **Debts** — closing a period turns each remainder / overpayment into a specific
   `EmployeeFinancialObligation`; settlement targets that obligation (cash direction
   follows the debt); write-off is explicit, permissioned and commented — never
   automatic, so a dismissed employee's debt survives.
7. **Surfacing** — company-wide ФОТ summary for owners, best-effort workflow
   notifications via the existing outbox, and payroll audit events labelled in the
   activity log.
8. **Integration** — the plan-adjusted manager scheme is prefilled from OFD / plan-sales
   data (preliminary ФОТ); personal-sales commission stays manual (no per-employee sales
   source exists).

## 2. New data models (all scalar-id, no Prisma relations)

`EmployeeClubAssignment`, `EmployeePayScheme`, `PayrollPeriod`, `PayrollCalculation`,
`PayrollAdjustment`, `PayrollAdvance`, `PayrollPayment`, `EmployeeFinancialObligation`.
`ClubEmployee` gained `hireDate`, `preferredPaymentMethod`, `isOfficial`,
`defaultLegalEntityId` (all nullable/defaulted). Money = integer kopeks; percentages =
basis points (100% = 10000 bp).

## 3. Migrations (non-destructive, dual-DB)

`20260723201402_add_payroll_module` in **both** `prisma/migrations/` (SQLite dev —
data-preserving rebuild) and `prisma/production/migrations/` (PostgreSQL — hand-written,
in-place `ALTER TABLE … ADD COLUMN` + `CREATE TABLE`, no DROP/rebuild). Destructive-SQL
scan on the production migration: clean.

## 4. Pages & API (server actions)

- **Pages** (`src/app/(app)/payroll/`): `/payroll` (roster), `/payroll/employees/[id]`
  (profile + assignments + scheme history + obligations), `/payroll/periods`,
  `/payroll/periods/[id]` (calculations, breakdown, workflow, adjustments, payments),
  `/payroll/obligations`, `/payroll/summary`. Registered as the `payroll` AppPage
  (owner/GD/regional/manager/accountant/chief-accountant) + a Finance nav item.
- **Server actions**: `updatePayrollProfile`, `saveClubAssignment`,
  `removeClubAssignment`, `savePayScheme`; `createPayrollPeriod`,
  `generateCalculations`, `saveCalculationInputs`, `transitionPeriod`, `addAdjustment`,
  `cancelAdjustment`, `recordPayment`, `cancelPayment`, `recordAdvance`,
  `cancelAdvance`; `settleObligation`, `writeOffObligation`. Every action resolves the
  access context + club scope + capability, guards month-close before mutating, and
  writes a server-side `recordAudit` after commit.
- **Libraries** (`src/lib/payroll/`): `enums`, `scheme`, `calc`, `period`, `access`,
  `assignments`, `schemes`, `compute`, `periods`, `aggregate`, `payments`,
  `obligations`, `sales-bases`.

## 5. Roles & rights

- **Assignments / profile / period / inputs**: regional director, manager (own scope).
- **Pay schemes**: owner, general director, regional director, chief accountant.
- **Approval**: manager submits; regional director approves the regional stage;
  accountant / chief accountant approve the accounting stage and close.
- **Adjustments**: operational band before approval; accounting band only after
  approval (locked); none once closed. Comment always required.
- **Cash payout**: manager/regional (from club/regional wallet). **Bank payout**:
  accounting.
- **Settle debt**: operational + accounting. **Write off**: owner / chief accountant
  only (comment required).
- **Summary**: any payroll-page role, club-scoped (owner/GD see every club).

## 6. Formulas implemented (engine)

Salary-by-shifts (§4.1), personal-sales commission 3%/4% (§4.1), gym-trainer per-package
40%/50% with the 70% prior-month gate + trainer credit (§4.2), hourly group trainer
(§4.3), senior group fixed + % (§4.4), manager plan-fact Scheme A with the
`200 bp × ceil(|deviation%|)` scale, ±40% cap and >20% manual-review flag (§4.5 —
verified against the spec's 36 000 / 28 800 examples), manager revenue-% Scheme B with
streak bonuses (§4.5), regional revenue-%/profit-% (§4.6), plus fixed/mixed. All params
are structured and validated — no formula strings, no `eval`.

## 7. Finance links (single source, spec §8)

Accrual = automatic ± approved adjustments. Paid = advance + confirmed payments, summed
separately so an advance is never double-counted. Cash payout writes one `CashMovement`
outflow (idempotent on `@@unique[sourceType, sourceId]`); cancellation posts a
compensating inflow — balances stay derived, never stored. Unpaid remainder at close →
`company_owes_employee`; overpayment → `employee_owes_company`. Debt repayment settles a
specific obligation, never a faceless «Приход Иное». Closed periods are immutable.

## 8. Manual parts (by design)

- **Personal-sales commission** (`salary_plus_percentage`, `sales_percentage`): there is
  no per-employee sales attribution in the data, so `netPersonalSalesKopeks` is entered
  manually.
- **Gym-trainer packages & provided sessions** (trainer credit): entered manually
  (provided sessions come from the senior trainer).
- **Bank payment confirmation**: manual until a bank integration exists.
- Only the **plan-adjusted manager / revenue-%** schemes are auto-prefilled (club-level
  plan + fact are the only structured sources).

## 9. Verification results

- `npx prisma validate` (dev + prod): valid.
- `npx tsc --noEmit`: clean.
- `npm run build` and `npm run build:prod`: pass (all 6 payroll routes compiled).
- `npm run pilot:full`: **2604 checks passed, 0 failed across 39 suites**, including the
  9 payroll suites (166 checks): `pilot-payroll` (43), `-setup` (23), `-periods` (21),
  `-workflow` (27), `-payments` (21), `-obligations` (16), `-surface` (11),
  `-integration` (11).
- `git diff --check`: clean. Production-migration destructive-SQL scan: clean.

## 10. Commit hashes (on `main`)

| Stage | Commit |
|---|---|
| 1 — foundation | `5e897f4` |
| 2 — setup | `0534d06` |
| 3 — calculations | `9cdd1f5` |
| 4 — workflow | `5d5c06f` |
| 5 — payments | `52f5188` |
| 6 — debts | `2e8e378` |
| 7 — surfacing | `7bea8cc` |
| 8 — integration + report | _this commit_ |

## 11. How to run the pilot

`npm run pilot:full` (or an individual `npm run pilot:payroll-*`) runs the deterministic
suites against the local SQLite dev DB (the runner refuses any non-`file:` database). To
walk the module in the UI, follow the flow in
[`../testing/payroll-pilot-scenarios.md`](../testing/payroll-pilot-scenarios.md).

## 12. Known limitations / open business questions

- Personal-sales commission, gym packages and provided sessions are manual inputs (no
  structured source). Confirm the intended data source or keep manual.
- Pay-scheme editing is **append-forward only** — to change pay you add a new
  effective-dated scheme; there is no in-place edit of a historical scheme.
- One calculation per employee per period (the first active assignment provides the role
  snapshot); an employee with multiple positions at one club is calculated once.
- Advances are tied to a generated period/calculation (earned-to-date = current net
  payable). A mid-month advance before the period exists is not yet supported.
- Regional-director city-level revenue/profit % uses a precomputed base (no automatic
  city aggregation yet).
- Bank payments are manually confirmed (no bank integration).
- Out of scope per §14 and untouched: employee self-cabinet, legal debt-collection
  documents, 1C export, automatic HR dismissal, ML, ФОТ analytics beyond the summary.

## 13. Assumptions recorded

- Pay-scheme configuration is a management/accounting-lead capability (not manager).
- ИП revenue counts as personal training (reused from the sales-report breakdown).
- Adjustments apply immediately (status `approved`) and are audited with their author;
  corrections after approval are accounting-only.
- Settlement of `company_owes_employee` in cash is a wallet outflow;
  `employee_owes_company` repayment is a wallet inflow.
