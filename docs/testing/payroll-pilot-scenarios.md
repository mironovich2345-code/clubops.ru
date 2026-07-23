# Payroll — one-club pilot scenarios

**Status:** Stage 1 delivers the **calculation engine + data model + tests**. The
end-to-end pilot below is executed as Stages 4–8 land (workflow, payments, cash link,
UI). Each scenario lists the calc inputs (already testable via `scripts/pilot-payroll.mjs`)
and the workflow/finance expectations to verify once persistence + payments exist.

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

## Currently automatable (Stage 1)

`scripts/pilot-payroll.mjs` already verifies the calculation math for scenarios 1–5, 7, 10–15, plan-fact examples, ±40% cap, streak bonus, trainer credit, aggregation (gross/net/remaining/debt), advance-not-double-counted, and the status machine (permissions + illegal-transition + lock). Payment/cash-ledger scenarios (6, 8, 9) are wired + tested in Stage 5.
