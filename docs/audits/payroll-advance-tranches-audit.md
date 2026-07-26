# Аудит аванса под транши (STAGE 9)

Аудит фактической реализации **до** изменения финансовой модели. Деньги — целые копейки.
Файлы: `src/app/(app)/payroll/advance-actions.ts`, `src/lib/payroll/{aggregate,salary-expense,payments}.ts`,
модель `PayrollAdvance` (`prisma/schema.prisma:1335`).

## 1. Как сейчас создаётся аванс
`recordEmployeeAdvance` (advance-actions.ts:77): один `PayrollAdvance` на
(employeeId, clubId, periodYear, periodMonth) — жёсткий `@@unique` (schema 1360). Дедуп:
второй аванс в статусе paid/approved/requested отклоняется (advance-actions.ts:103). Ручная
база управляющего → статус `requested` (подтверждает регионал); авто/регионал → сразу `paid`
+ выплата.

## 2. Когда создаётся Expense
Только при **выплате** (`payoutAdvance` → `createSalaryExpense{kind:"advance"}`,
advance-actions.ts:54; salary-expense.ts:22): один `Expense{category:"salary"}`. При
**согласовании** Expense НЕ создаётся.

## 3. Когда создаётся движение денег
Тоже при выплате: для наличных `createSalaryExpense` вызывает `recordExpenseMovement` —
одно `CashMovement` (salary-expense.ts). Безнал — без движения кассы. При согласовании
движения нет.

## 4. Как аванс уменьшает остаток зарплаты
`recomputeCalculationTotals` (aggregate.ts:29-39): суммирует **paid** `PayrollAdvance` по
employee+club+month → `advancesKopeks`; `paid = advance + otherPayments`,
`remaining = net − paid`. Начисление (`grossAccrued`) не уменьшается. Аванс НИКОГДА не
считается вторично как `PayrollPayment` (комментарий aggregate.ts:28).

## 5. Что делает отмена/сторно
`cancelEmployeeAdvance` (advance-actions.ts:175): если paid → `cancelSalaryExpense`
(reverse cash один раз, Expense→cancelled), статус → `canceled`, recompute. Отмена — на
уровне **всего аванса** (нет отмены отдельного платежа).

## 6. Что мешает нескольким выплатам
Единственные `amountKopeks` + `expenseId` на `PayrollAdvance` — **один платёж = один
аванс**. Нет сущности транша, нет `approvedAmount` vs `paidAmount`. `earnedToDateKopeks` —
только потолок (advanceWithinEarned). Значит несколько выплат сейчас невозможны.

## 7. Что мигрировать
Аддитивно: `PayrollAdvance += requestedAmountKopeks, approvedAmountKopeks` (+ опц.
`linkedPayrollCalculationId`). Новая таблица `PayrollAdvancePayment` (транш) с собственными
expenseId/cashMovementId/idempotencyKey/reversal-полями. Старые поля (`amountKopeks`,
`expenseId`, `paidAt`, статусы) **не удалять**.

## 8. Как сохранить старые авансы
Backfill: для каждого `paid` аванса — один **legacy-транш** на всю сумму, ссылающийся на
**существующие** Expense и CashMovement (по expenseId); `approvedAmount = requestedAmount =
amountKopeks`. Новый Expense/движение при backfill НЕ создаются. Неоднозначные связи —
помечать на ручную проверку, не угадывать. Даты/авторы — по возможности из исходных полей.

## 9. Риск двойного расхода
Сейчас его нет (аванс не пере-признаётся при финальной зарплате — aggregate только
уменьшает remaining). Риск появится, если backfill создаст новый Expense — поэтому backfill
переиспользует существующий. Новый сервис траншей должен создавать **один** Expense **на
транш** и НИ одного при согласовании.

## 10. Риск двойного движения денег
Сейчас одно движение на выплату. Риск: retry/refresh формы. Защита — `idempotencyKey`
(unique) на транше + транзакция; один `cashMovementId` не привязан к двум траншам.

## 11. Что при создании периода после выплаченного аванса
`payoutAdvance`/aggregate связывают аванс с расчётом по employee+club+month и
пересчитывают remaining — **без** нового Expense/движения/второго объекта. После перехода:
fold по сумме **активных траншей** (не по approvedAmount).

## 12. Что при удалении/увольнении сотрудника
Аванс и его финансовые связи сохраняются (история). Уволенный не попадает в активный
состав, но его авансы/расчёты остаются в закрытых периодах. Удаление сотрудника не
предусмотрено (soft-статусы).

## Выбранная финансовая модель (STAGE 9)

- Согласование аванса **не двигает деньги**.
- Каждый выплаченный **транш** = один `Expense{category:salary, kind:advance}` + (для
  наличных) одно `CashMovement`. Идемпотентно по `idempotencyKey`.
- `paidAmount(advance) = Σ активных (не сторнированных) траншей`;
  `remaining(advance) = approvedAmount − paidAmount`.
- Fold в зарплату: `advancesKopeks = Σ активных траншей` месяца; **approved, но не
  выплаченная** часть НЕ уменьшает salary remaining. Транзишн-безопасно: если у аванса нет
  траншей, берётся legacy `amountKopeks` для `paid`-аванса (0 для `approved`).
- Финальная зарплата расход не пере-признаёт — только уменьшает remaining.
- Сторно — **на уровне транша**: reverse cash один раз, транш→reversed, recompute;
  закрытый период прямое сторно запрещает.

## Backfill/скрипты
`payroll:advance-audit` (dry-run, счётчики без ПДн/секретов), `payroll:advance-backfill`
(dry-run по умолчанию, `--apply`): создаёт legacy-транши, переиспользуя Expense/движение,
считает конфликты и записи на ручную проверку.

## Что НЕ трогаем этим этапом
Workflow регионал→ГД (10–11), versioned schemes (12), OfdCashierMapping (13), авто-атрибуция
продаж. Существующие статусы аванса сохраняются + пользовательский mapping (§5).
