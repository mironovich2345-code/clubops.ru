# Payroll — one-club pilot scenarios

**Status:** all 8 stages are implemented and merged to `main`. The calculation engine,
data model, employee/scheme setup, period calculations, approval workflow, advances/
payments with cash-ledger integration, debts/settlement, ФОТ summary/notifications, and
the OFD/plan prefill are all in place. Every scenario below is covered by the automated
`scripts/pilot-payroll*.mjs` suites (166 checks) and by walking the club pilot in the UI.

**How to run the pilot in the UI:** create employees in `/employees`, set their club
assignments + a pay scheme in `/payroll/employees/[id]`, create a period in
`/payroll/periods`, «Сформировать расчёты», enter/verify inputs (plan-fact managers are
prefilled from OFD/план), submit → regional approve → accountant approve, record
advances/payments, close the month, and settle any resulting obligation in
`/payroll/obligations`.

## Test data — club "ГринЛайт" (July 2026)

| Employee | Position | Scheme | Key params |
|---|---|---|---|
| Иван (управляющий) | manager | plan_adjusted_salary | subs base 60 000 ₽, PT base 30 000 ₽; caps ±40% |
| Пётр (менеджер) | administrator | salary_plus_percentage | base 30 000 ₽, norm 15, 3%/4% |
| Сергей (тренер ТЗ) | gym_trainer | (per-package) | 40% ≤ 20 000 ₽, else 50%; plan gate 70% |
| Анна (групповой) | group_trainer | hourly | 700 ₽/час |

Legal entity = club's active ИП. Cash source = club_cash. Approver chain: Иван → регионал → бухгалтер.

## Scenarios

| # | Scenario | Inputs | Expected result | Roles | Balances/debts | Audit |
|---|---|---|---|---|---|---|
| 1 | Обычный расчёт (менеджер) | 12/15 смен, продажи 500 000 ₽, план выполнен | оклад 24 000 + 4% = 20 000 → 44 000 ₽ | manager creates | — | payroll.calculated |
| 2 | План выполнен / не выполнен | planMet true→4% / false→3% | 20 000 / 15 000 ₽ | manager | — | — |
| 3 | Управляющий план-факт | subs 928 637/1 350 000, PT 1 137 417/1 150 000 | 36 000 + 28 800 = 64 800 ₽; subs flagged manual (>20%) | manager | — | payroll.calculated (needsManualReview) |
| 4 | Премия | +5 000 ₽ bonus (комментарий обязателен) | gross +5 000 | manager adds | — | payroll.adjustment (bonus) |
| 5 | Штраф | −2 000 ₽ penalty | gross −2 000 | manager | — | payroll.adjustment (penalty) |
| 6 | Аванс | 20 000 ₽ наличными, earned-to-date ≥ 20 000 | касса ИП −20 000; paid +20 000; один аванс/месяц | manager marks paid | club cash −20 000 | payroll.advance_paid |
| 7 | Частичная выплата | начислено 47 000, выплачено 30 000 | остаток 17 000 → долг компании | manager cash | company_owes_employee 17 000 | payroll.payment |
| 8 | Наличная выплата | ведомость приложена | касса −сумма один раз (cashMovement link) | manager/regional | club cash − | payroll.payment (cash) |
| 9 | Безналичная выплата | bank, ручное подтверждение до банка | подтверждается бухгалтером | accountant | — | payroll.payment (bank) |
| 10 | Переплата | выплачено 35 000 > начислено 30 000 | долг сотрудника 5 000 | accountant | employee_owes_company 5 000 | payroll.obligation |
| 11 | Недоплата | остаток не выплачен | долг компании | — | company_owes_employee | payroll.obligation |
| 12 | Кредит тренера | оплачено 12, проведено 8, цена 1 500 | overpaid 6 000 → debit при увольнении | senior trainer вводит проведённые | — | payroll.adjustment (trainer_credit_recovery) |
| 13 | Увольнение | текущий месяц + авансы − кредит | итог company/employee_owes; долг не списывается | manager runs final | обязательство сохраняется | payroll.final_settlement |
| 14 | Корректировка бухгалтером | после утверждения, с комментарием | прямое редактирование заблокировано; только adjustment | accountant | — | payroll.adjustment (correction) |
| 15 | Закрытие месяца | все расчёты утверждены, выплаты классифицированы | статус closed; остаток → долг компании; период иммутабелен | regional+accountant | — | payroll.period_closed |

## Invariants to verify

- **Единое списание кассы:** наличная выплата/аванс уменьшает кошелёк ровно один раз (через существующий `CashMovement`), отмена выплаты восстанавливает остаток.
- **Аванс не дублируется:** аванс входит в `paidKopeks`; при финальном расчёте не добавляется повторно.
- **Иммутабельность:** утверждённый расчёт нельзя редактировать напрямую; закрытый месяц нельзя переписать.
- **Долги:** возврат денег сотрудником гасит КОНКРЕТНОЕ обязательство, а не «Приход Иное».
- **Права (server-side):** manager (свой клуб), regional (регион), accountant (корректировки/безнал/закрытие), owner (только агрегаты ФОТ).

## Automated coverage (all stages)

Nine pilot suites, 166 checks total, all green in `npm run pilot:full`:

- `pilot-payroll.mjs` (43) — calc engine + status machine (scenarios 1–5, 7, 10–15, plan-fact examples, ±40% cap, streak bonus, trainer credit, aggregation, advance-not-double-counted).
- `pilot-payroll-setup.mjs` (23) — assignments + effective-dated schemes + no-recompute-of-closed-month.
- `pilot-payroll-periods.mjs` (21) — compute dispatch + period totals + snapshot immutability.
- `pilot-payroll-workflow.mjs` (27) — transitions, lock, comment-required adjustments, aggregation.
- `pilot-payroll-payments.mjs` (21) — advances + payments + cash outflow/reversal balance math (scenarios 6, 8, 9).
- `pilot-payroll-obligations.mjs` (16) — debts on close, specific settlement, no auto write-off (scenarios 10, 11, 13, 15).
- `pilot-payroll-surface.mjs` (11) — ФОТ summary + notifications + activity labels.
- `pilot-payroll-integration.mjs` (11) — OFD/plan prefill + preliminary ФОТ (scenario 3).
