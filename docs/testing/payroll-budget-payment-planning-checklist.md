# Manual acceptance — Payroll → Salary Budget → Payment Planning

Static + pilots + build are green (68/68; pilot:full 3641/0; build:prod compiled). This covers live
data. Run as owner/GD, regional director, chief accountant, and a manager to confirm scope + RBAC.

## Forecast (number A)
- [ ] The «Зарплата — планирование» panel on **Бюджеты** shows a **Прогноз** per club from active schemes.
- [ ] A club with an unconfigured scheme or a variable-pay employee shows the **«*» / «прогноз неполный»** marker — never a silent 0 ₽.
- [ ] Changing a pay scheme changes the **forecast only**; an already-approved/closed period's Начислено is unchanged.
- [ ] The forecast never appears as a dated line on the payment calendar (planning only).

## Budget linkage + proposal (number B)  (GATE)
- [ ] The panel shows five labelled numbers: **Прогноз · Бюджет · Начислено · Выплачено · К выплате** + **Отклонение**.
- [ ] Отклонение % shows **«— (прогноз неполный)»** when the forecast is 0, not «0 %».
- [ ] Editing a pay scheme does **not** silently change the salary Budget.
- [ ] A **regional director** can create a budget-change proposal; **owner/GD** can approve/reject; an **accountant/manager cannot**.
- [ ] Approving a proposal updates the Budget to the proposed limit; rejecting leaves it unchanged. The proposal row is never deleted (status flips).
- [ ] `salaryBudgetSyncMode` defaults to **suggested**; `auto_sync` only applies automatically when explicitly selected.

## Payment obligation + calendar (numbers C/D)  (GATE)
- [ ] Approving a payroll period creates «Зарплата к выплате» obligations for that period.
- [ ] With a **pay schedule set** (день расчёта), the obligation appears on the payment calendar on the right date.
- [ ] With **no schedule**, the obligation is recorded but does **not** appear on the dated calendar (no faked date).
- [ ] The calendar amount equals the **outstanding remaining**, not the gross accrual (no double count).
- [ ] An advance already paid is folded in: 100 000 accrued + 40 000 advance shows **60 000 к выплате**, never 140 000.
- [ ] Recording a partial payment reduces the obligation remaining; the total across payments is exact (kopeks).
- [ ] Cancelling a payment restores the remaining correctly.
- [ ] Re-approving / re-running does **not** create duplicate obligations (idempotency key).

## Reversal + scope  (GATE)
- [ ] Only a **chief accountant** can cancel an obligation; a reason is required; the row is not deleted.
- [ ] A cancelled obligation is **not resurrected** when the period regenerates obligations.
- [ ] Every obligation carries a **legal entity**; no cross-entity or cross-company obligation/payment appears.
- [ ] A shared employee with no allocation rule lands in **«Не распределено»**, not an auto-split.

## Settings + ops
- [ ] Owner/GD can set advance day, final day (1–28), weekend rule, taxes-in-budget flag, and sync mode.
- [ ] `npm run preflight:payroll-budget-payment-planning` runs read-only and reports 0 problems on clean data.
- [ ] `npm run backfill:payroll-obligations` (dry-run) reports candidates; `--apply` creates them and changes **no** budget.

**Sign-off:** accepted when every GATE section passes on a real instance with real periods,
schedules, and payments, and cross-scope/cross-entity is confirmed excluded.
