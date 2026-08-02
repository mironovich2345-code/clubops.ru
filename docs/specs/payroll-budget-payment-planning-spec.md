# Spec — Payroll → Salary Budget → Payment Planning

Companion to `docs/audits/payroll-budget-payment-planning-audit.md`. Defines the accounting
model, the new entities/services, RBAC, and the invariants the pilot enforces. Additive to a
mature payroll engine — see the audit for what already exists.

---

## 1. Accounting definitions (the four numbers + remaining)

| Symbol | Name | Definition | Source |
|---|---|---|---|
| **A** | Прогнозный ФОТ | projected cost of a **future** period from active pay schemes + planned inputs | `calculatePayrollForecast()` (derived, never stored as fact) |
| **B** | Утверждённый бюджет ЗП | approved spending limit for salary | `Budget{category:"salary"}.limitAmountKopeks` |
| **C** | Начислено / к выплате | approved amount owed for a **closed/approved** period | `PayrollCalculation.grossAccruedKopeks` / `netPayableKopeks` |
| **D** | Фактически выплачено | money actually paid | `PayrollPayment` + salary `Expense` |
| **R** | Остаток к выплате | `netPayableKopeks − paidKopeks` (advances already folded) | `PayrollCalculation.remainingKopeks` |

**Never merge A/B/C/D.** Forecast is planning; budget is a limit; accrual is a liability;
payment is cash. A change to one does not silently mutate another.

---

## 2. `calculatePayrollForecast` (WAVE 1)

**Inputs:** `{ companyId, clubId?, legalEntityId?, period(year,month), activeSchemes, plannedInputs? }`.
**Output:**
```
{
  totalKopeks,
  byClub:        { clubId → kopeks },
  byCategory:    { управляющий|административный|тренеры_тз|тренеры_пт|другое → kopeks },
  byEmployee:    { employeeId → kopeks },
  byLegalEntity: { legalEntityId → kopeks },
  byPayDate:     { isoDate → kopeks },      // only when schedule known
  warnings:      Warning[],                  // «Прогноз неполный» — never silent 0
  confidence:    "complete" | "partial",
}
```
**Rules:** derive only from **active** `EmployeePayScheme` (current version) + planned shifts/sales
where provided. Missing scheme / missing plan / unknown paydate ⇒ push a warning and mark
`confidence:"partial"`; **do not emit 0 as if it were a real forecast.** Integer kopeks only.
Forecast is read-only — it writes nothing and never enters `PaymentObligation[]`.

---

## 3. Budget linkage + sync (WAVE 2)

- Read-side display per club+month: **Прогноз (A) · Бюджет (B) · Начислено (C) · Выплачено (D) · К выплате (R)** — all labelled, never a single blended number.
- `budgetVariance = B − A`; `budgetVariancePercent = A > 0 ? variance/A : null`.
- **`salaryBudgetSyncMode`** (company, default **`suggested`**):
  - `manual` — no proposals generated.
  - `suggested` — forecast drift raises a `BudgetChangeProposal` for humans to approve.
  - `auto_sync` — proposal auto-applies **only when explicitly enabled**; still recorded append-only.
- **`BudgetChangeProposal`** (append-only): current vs proposed limit, reason, source
  (`forecast_drift|manual|scheme_change`), status (`pending|approved|rejected|superseded`).
  Never edits `Budget` directly except through an approved proposal.
- **RBAC:** regional_director **proposes**; owner / GD **approve/reject**; accountant / manager
  **view**. Do not widen owner/GD; do not touch «Реклама — только ГД».

---

## 4. Payroll payment obligation (WAVE 3)

**`PayrollPaymentObligation`** created from an **approved** `PayrollPeriod` (status past
`regionalApprovedAt`/`accountingApprovedAt`, never from forecast or draft).

- Granularity: **legalEntity + club + category + dueDate** (employee optional).
- `amountKopeks = Σ netPayableKopeks` for the slice (advances already folded).
- `remainingKopeks = amountKopeks − Σ confirmed PayrollPayment (± reversals)` for the slice.
- `status`: `planned → due → partially_paid → paid` (or `cancelled` with reason).
- `idempotencyKey = company:club:legalEntity:category:period:dueDate` (unique) → re-run upserts, never duplicates.
- **Wire** `buildPayrollObligations()` to emit these as `PaymentObligation[]` (`sourceType:"payroll"`, `category:"salary"`) → they appear on /payments, upcoming, cash-gap, accountant workspace automatically.
- **Pay schedule** (company): `payrollAdvanceDay`, `payrollFinalDay`, weekend rule, timezone. Missing ⇒ warn «график не задан», never fabricate a date.

**Payment calendar shows three separate rails:** «Ожидаемый ФОТ» (forecast, planning only) ·
«Зарплата к выплате» (obligation) · actual paid. No number appears on two rails.

---

## 5. Advances / partial payments / reversal / remaining (WAVE 4 — mostly existing)

Already enforced by the engine; this epic verifies + surfaces at the obligation level:
- Advance = a `PayrollPayment` that reduces `netPayableKopeks`/remaining — never an added line (100k + 40k adv ⇒ 60k).
- Partial payments append `PayrollPayment` rows; `paidKopeks = Σ confirmed − reversals`; `remaining = netPayable − paidKopeks`; overpayment blocked.
- Reversal: `reverseCashOutflow()` + salary-Expense cancellation, **chief_accountant only**, reason required, never deletes.
- Obligation `remainingKopeks` recomputed from the same confirmed-minus-reversed payments (no parallel ledger).

---

## 6. Legal-entity + shared-employee + taxes (cross-cutting)

- Every obligation/payment carries `legalEntityId`; no cross-entity or cross-company linkage.
- Shared employee with no allocation rule ⇒ company-level "Не распределено по клубам"; never silent even split.
- `salaryBudgetIncludesTaxes` (company, default **off**); no tax rate hardcoded.

---

## 7. Invariants (pilot-enforced)

1. Money is integer kopeks everywhere; no float.
2. A, B, C, D, R are distinct fields/derivations; none overwrites another.
3. Forecast writes nothing and never enters `PaymentObligation[]`.
4. Approved/closed period accrual is never re-derived from a later scheme change.
5. Scheme change affects only future forecast (+ optionally a proposal), not past C.
6. Budget changes only via an approved `BudgetChangeProposal` (except explicit `auto_sync`).
7. `salaryBudgetSyncMode` default `suggested`; `auto_sync` requires explicit opt-in.
8. Obligation from approved period only; `idempotencyKey` prevents duplicates.
9. `remaining = netPayable − paidKopeks`; advances folded once; no double count.
10. Overpayment blocked; reversal chief-only + reason + append-only.
11. Every obligation/payment has `legalEntityId`; no cross-entity/company links.
12. Missing forecast/cash ⇒ warning + `null`, never a silent 0.
13. `budgetVariancePercent = null` when forecast ≤ 0.
14. `cashDeficit = null`/«Недостаточно данных» when cash unknown.
15. Shared employee with no rule ⇒ "Не распределено", never auto-split.
16. Taxes in budget only when `salaryBudgetIncludesTaxes`; no hardcoded rate.
17. Calendar three-rail separation: forecast ≠ obligation ≠ actual (no line double-counted).
18. Migrations additive; no drop/type-change; backfill dry-run/apply + idempotent + no budget mutation.

---

## 8. Roles matrix

| Action | regional | owner | GD | chief_acct | accountant | manager |
|---|---|---|---|---|---|---|
| View forecast/budget/plan | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (scope) |
| Propose budget change | ✓ | ✓ | ✓ | — | — | — |
| Approve/reject budget change | — | ✓ | ✓ | — | — | — |
| Generate obligation (approve period) | — | — | ✓ | ✓ | ✓ | — |
| Record payment/advance | — | — | — | ✓ | ✓ | — |
| Reverse payment | — | — | — | ✓ | — | — |
