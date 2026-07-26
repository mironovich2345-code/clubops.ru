# Аудит модуля «Зарплата (ФОТ)» под новую ролевую структуру

Аудит **до** изменения бизнес-логики (требование §1). Ниже — состояние текущего движка,
ответы на 8 обязательных вопросов, статус каждого требования и план миграций/этапов.
Деньги — целые копейки; проценты — базисные пункты (bp): 100 % = 10000 bp.

Файлы движка: `src/lib/payroll/{compute,calc,scheme,schemes,trainer,sales-bases,aggregate,periods,period,access,enums,obligations,payments,salary-expense}.ts`;
модели `prisma/schema.prisma` (EmployeePayScheme 1220, PayrollPeriod 1241, PayrollCalculation 1265,
PayrollAdjustment 1310, PayrollAdvance 1335, PayrollPayment 1367, PayrollTrainerPackage 2141).

## 8 обязательных вопросов

1. **Аванс — один платёж?** Да. `PayrollAdvance` — одна строка на (employee, club, month),
   `@@unique` (1360), единственные `amountKopeks` (1343) и `expenseId` (1351). Нет таблицы
   траншей, нет разделения «согласовано vs выплачено». → **Отсутствует; нужна аддитивная
   миграция** (approvedAmountKopeks на PayrollAdvance + новая таблица траншей
   PayrollAdvancePayment со своим expenseId/движением кассы).
2. **Двойной расход аванс+финал?** Нет. Аванс проводится одним `Expense{category:salary,
   kind:advance}` + одно движение кассы; при recompute учитывается в `paid`/`remaining`
   и НИКОГДА не считается вторично как выплата (`aggregate.ts:28-34`). Финальная выплата —
   отдельный `PayrollPayment` за отдельную сумму. **Инвариант сохранить.**
3. **Trainer credit ограничивает начисление?** **Нет** (уже так). `calcGymTrainer` не
   ссылается на кредит; кредит — информативный показатель/обязательство, вычитается только
   вручную при увольнении (`trainer_credit_recovery`, dismissal-only). → **§7 в основном
   выполнено движком.** Наши формулы это сохраняют (кредит не в total).
4. **Разные схемы по клубам?** Да. `EmployeePayScheme.clubId` + effective-dated
   (effectiveFrom/To). НО position/category-уровень (`employeeId=null`) в рантайме **не
   резолвится** (`getEffectiveSchemeForEmployee` требует точный employeeId). → **Частично;
   нужна доработка резолвинга схемы до уровня клуб+категория (fallback на employeeId=null).**
5. **Snapshot схемы в периоде?** Да, `schemeSnapshotJson` + `makeSchemeSnapshot`; движок
   пересчитывает из snapshot, не из живой схемы. **Закрытые периоды защищены.**
6. **Согласование отдельных параметров?** **Нет.** Есть только (а) state-machine периода,
   (б) корректировки (bonus/penalty), создаваемые сразу `approved`. Нет процесса «регионал
   предложил параметр → ГД одобрил». → **Отсутствует; новый workflow** (см. §13/§14) на
   базе новой сущности + статусов.
7. **Возвраты и привязка к сотруднику?** Личная выручка сейчас **вводится вручную** (нет
   пер-кассирной атрибуции ОФД; `sales-bases.ts` явно это отмечает). Возвраты по личным
   продажам — ручной «чистый» показатель. Пакеты тренера — возврат привязан к пакету
   исходного тренера (`net = contract − refund`). → **Пер-кассирная атрибуция ОФД
   отсутствует; нужна модель mapping ОФД-кассир→сотрудник** (§17).
8. **Пересчёт закрытых периодов при смене схемы?** Нет — snapshot + append-forward-only.
   **Инвариант сохранить.**

## Статус требований (реализовано / частично / отсутствует / конфликт / миграция / UI)

| Требование | Статус | Как реализовать |
|---|---|---|
| §2 5 карточек-категорий (управляющий/админсостав/ТЗ/ГП/аванс) | отсутствует | **UI-оболочка** над периодом + классификатор `categoryOfPosition` |
| §2 уволенные скрыты в текущих, видны в истории/закрытых | частично | ростер фильтрует `status:"active"`; закрытый период хранит расчёты — UI: архив-режим |
| §3.1 управляющий: АБ и ПТ отдельно, откл.×2, лимит ±40% | отсутствует (формула универсальная) | **новый формульный движок** `formulas.ts:managerSalary` + params в схеме |
| §4 администратор = ставка×смены (не «оклад»), норма — контроль | частично | схема `salary_by_shifts` есть; формула/лейблы — `administratorSalary` |
| §5 менеджер продаж: оклад/15, тир-процент от плана клуба (3/4/…%) | отсутствует | `salesManagerSalary` + тиры в схеме; новая позиция `sales_manager` |
| §6 ночной менеджер: ставка×смены + тот же тир-процент | отсутствует | `nightManagerSalary` |
| §7 тренер ТЗ: новые/продления %, кредит информативно | частично | кредит уже информативен; новые/продления % — `gymTrainerSalary` |
| §8 старший ТЗ: повышенный % от общего плана ПТ | отсутствует | `seniorGymTrainerSalary` (тиры) |
| §9 тренер ГП: часы×ставка + личный % | частично | `hourly` есть; личный % — `groupTrainerSalary` |
| §10 старший ГП: +5000 + 10 % от всей выручки ГП | частично | `calcSeniorGroup` есть частично; `seniorGroupTrainerSalary` (настраиваемо) |
| §11 аванс: 1 объект/мес + несколько траншей | отсутствует | **миграция**: approvedAmount + таблица траншей |
| §12 закрытые поля для управляющего | частично | права есть; UI: поля read-only по роли |
| §13 регионал предлагает (разово / схема) | отсутствует | **новая сущность** PayrollChangeRequest + статусы |
| §14 очередь согласования ГД | отсутствует | UI-очередь + действия одобрить/отклонить/вернуть |
| §15 полная история/аудит изменений | частично | `recordAudit` есть; для параметров — поля old/new в change-request |
| §16 versioned-схемы (status/version/approvedBy) | частично | схема effective-dated; **аддитивно** добавить version/status/approvedBy |
| §17 ОФД-кассир→сотрудник mapping | отсутствует | **новая модель** OfdCashierMapping + статусы |
| §18 шапка периода с прогрессом | частично | шапка есть; добавить «заполнено N из M» |
| §19 пользовательские статусы блоков | частично | mapping поверх backend-статусов (не ломать state machine) |
| §20 валидация отправки на согласование | частично | часть гейтов есть (`applyPayrollAction`); добавить проверки полей |
| §21 мобильная версия | частично | ростер уже адаптивен; карточки категорий — вертикально |

## План миграций (только аддитивные, non-destructive, §23)

1. **PayrollAdvance**: `+ approvedAmountKopeks Int?` (согласованная сумма). Существующий
   `amountKopeks` остаётся (backfill approvedAmount = amountKopeks). Новая таблица
   **PayrollAdvancePayment** (транш): id, advanceId, amountKopeks, paymentMethod,
   legalEntityId, expenseId, cashMovementId, status, paidByUserId, paidAt, createdAt.
2. **EmployeePayScheme**: `+ version Int @default(1)`, `+ status String @default("active")`,
   `+ approvedByUserId String?`, `+ category String?` (для схем уровня категории).
3. **PayrollChangeRequest** (новая): id, companyId, clubId, employeeId?, periodId?, scope
   (one_time|scheme), field, oldValueJson, newValueJson, amountKopeks?, effectiveFrom?,
   reason, status (draft|pending_gd|approved|rejected|returned), createdByUserId,
   decidedByUserId?, decidedAt, impactKopeks?, createdAt.
4. **OfdCashierMapping** (новая): id, provider, companyId, clubId, legalEntityId?,
   cashierName, normalizedCashierName, employeeId?, status (auto_matched|confirmed|
   unmatched|ambiguous|manually_assigned|excluded), confirmedByUserId?, confirmedAt,
   effectiveFrom?, effectiveTo?.

Обоснование JSON vs колонки (§23): пороги/проценты/оклады категорий хранятся в
`EmployeePayScheme.paramsJson` (уже JSON) и фиксируются в `schemeSnapshotJson` расчёта — новые
параметры (АБ/ПТ-оклады, тиры процентов, ставки, лимит ±40%) **не требуют новых колонок**,
только расширения структуры params. Отдельные снапшоты АБ/ПТ план/факт кладутся в
`detailsJson` расчёта. Реальные новые таблицы нужны лишь для траншей аванса, change-request
и cashier-mapping.

## Что нельзя пересчитывать / ломать (инварианты)

- Snapshot схемы → закрытые/прошлые периоды не пересчитываются при смене схемы.
- Аванс не даёт двойной расход; транши суммарно ≤ согласованной суммы; при финале расход
  не создаётся повторно.
- Trainer credit не уменьшает начисление (только ручное взыскание при увольнении).
- Возврат уменьшает выручку исходного продавца (для ОФД — через mapping, не «кассир возврата»).
- Все операции tenant-safe, club-scoped; нельзя согласовать собственное изменение (capability).

## Формульный движок (реализовано этим этапом)

`src/lib/payroll/formulas.ts` — чистые, **настраиваемые** функции (без зашитых ставок):
`managerSalary` (АБ/ПТ отдельно, откл.×2, clamp ±limit), `administratorSalary`
(ставка×смены, норма — контроль), `salesManagerSalary` (оклад/15 + тир-процент от плана
клуба), `nightManagerSalary`, `gymTrainerSalary` (новые/продления, кредит информативно),
`seniorGymTrainerSalary` (тиры от плана ПТ), `groupTrainerSalary` (часы + личный %),
`seniorGroupTrainerSalary` (+фикс +доля от выручки ГП), `pickPercentTier` (3–4+ уровней),
`completionBp`, `clampBp`, `categoryOfPosition`. Покрыто `pilot:payroll-formulas`.

## Порядок этапов (§25)

1. ✅ Аудит + формульный движок + тесты формул (этот коммит-набор).
2. Классификатор категорий + позиция `sales_manager` + резолвинг схемы клуб+категория.
3. 5 карточек и навигация (UI-оболочка над периодом).
4. Администраторы; 5. менеджеры/ночные; 6. управляющий; 7. тренеры ТЗ; 8. тренеры ГП —
   подключение `formulas.ts` к compute через params/snapshot (по одной категории за коммит).
9. Аванс + транши (миграция). 10. Корректировки регионала (change-request).
11. Согласование ГД. 12. Versioned-схемы (аддитивные поля). 13. OFD cashier mapping.
14. Mobile / tests / docs.

**Ограничение честности:** до подключения `formulas.ts` к периоду через snapshot и до
реализации траншей/согласования/маппинга задача НЕ считается завершённой (см. §27 запреты).

## Обновление: STAGE 2 + STAGE 3–8 выполнены

- STAGE 2: `categories.ts` (8 категорий ≠ 5 UI-групп; unknown), позиция `sales_manager`,
  `resolveSchemeForCalc` (приоритет сотрудник → категория клуба → not_configured/conflict).
- STAGE 3–8: аддитивная миграция `calculationEngineVersion` (legacy_v1|role_categories_v2);
  8 `role_*` типов схем + params + валидация; `role-compute.ts` подключает `formulas.ts` к
  `computeScheme` (единая точка); `generateCalculations`/`collectPeriodInput`/`CalculationCard`
  проводят входы и расчёт role-категорий; 5 карточек периода. Формулы реально участвуют в
  расчётах новых периодов. Закрытые периоды защищены snapshot. Тесты:
  `pilot:payroll-role-cards-stage2` (25), `pilot:payroll-formulas` (28), pilot:full 2940/0.
- Осталось: STAGE 9 (транши аванса), 10–11 (регионал→ГД), 12–13 (versioned schemes +
  OfdCashierMapping), 14 (mobile/детальные вкладки/финальные гайды). См.
  `docs/testing/payroll-role-cards-stage2-report.md`.
