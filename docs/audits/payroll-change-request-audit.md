# Аудит: предложения изменений зарплаты (STAGE 10–11)

Аудит **до** изменения бизнес-логики. Цель: регионал предлагает изменение закрытых для
управляющего параметров, но изменение **не влияет на расчёт до согласования ГД/собственника**.
Файлы: `src/lib/payroll/{compute,role-compute,scheme,aggregate,calc,period,access}.ts`,
`src/app/(app)/payroll/periods/actions.ts`, модели `PayrollCalculation`, `PayrollAdjustment`,
`EmployeePayScheme`.

## 12 вопросов

1. **Что можно менять напрямую сейчас.** Управляющий/регионал (`canManagePayrollAssignments`)
   вводят inputs (смены/часы/план-факт/личная выручка) и добавляют корректировки
   (`addAdjustment`, bonus/penalty, комментарий обязателен). Схемы правит
   `canManagePaySchemes` (owner/GD/regional/chief_accountant) — append-forward.
2. **Что сразу влияет на расчёт.** Adjustments создаются сразу `approved` → сразу в gross
   через `recomputeCalculationTotals`. Смена схемы влияет только на будущие периоды (snapshot).
   **Нет** отложенного «предложил → одобрили».
3. **История old/new значения.** Для adjustments — нет old/new (просто новая строка). Смена
   схемы — append-forward (старая закрывается). Полноценной истории «параметр X: old→new» нет.
4. **Что уже согласуется.** Только период целиком через state-machine
   (draft→…→approved→…→closed). Отдельные ПАРАМЕТРЫ не согласуются.
5. **Права регионала.** `regional_director` ∈ `canManagePayrollAssignments`,
   `canManagePaySchemes`, capability `ofd.sync.trigger` и др. Он МОЖЕТ править схему напрямую.
6. **Может ли регионал изменить закрытый параметр без ГД?** Сейчас — **да** (правит схему/
   adjustments напрямую). Это и есть цель STAGE 10 — закрыть прямое применение, ввести
   согласование ГД.
7. **После согласования периода.** `isPayrollPeriodLocked` (approved/paid/closed) блокирует
   generate/save inputs; adjustments в locked → только accounting.
8. **В закрытом периоде.** `isPayrollPeriodClosed` — расчёты read-only; recompute не
   пере-запускает формулу (stored automatic). Изменения запрещены.
9. **Можно ли применить к одному сотруднику/месяцу.** Да — `PayrollCalculation` уникален по
   (period, employee); adjustment привязан к calc. Разовая корректировка — на этот calc.
10. **Новая схема с будущей даты.** Да — `EmployeePayScheme.effectiveFrom`, append-forward.
    Прошлые snapshot не меняются.
11. **Что переиспользовать.** `PayrollAdjustment` (для разовой премии), `computeScheme`/
    `role-compute` (для preview/apply — единый расчётный путь), `recomputeCalculationTotals`,
    state-machine, `recordAudit`, notification events (`notifyRegionalReview`/`notifyAuthor`).
12. **Нужна ли новая модель.** Да — `PayrollChangeRequest` (аддитивно) для процесса
    предложение→решение с историей old/new/impact/revisions. Плюс `PayrollCalculation.
    approvedOverridesJson` для хранения approved-override отдельно от base snapshot.

## Два типа изменений (§2)
- **period_adjustment** — разово на конкретный `PayrollCalculation` (percent/base/бонус).
- **future_scheme_change** — новая effective-dated схема (клуб/категория/сотрудник, дата).

## Целевая модель

**`PayrollChangeRequest`** (аддитивно): id, companyId, clubId, employeeId?, payrollPeriodId?,
payrollCalculationId?, payrollSchemeId?, requestType (period_adjustment|future_scheme_change),
fieldType (percentage|base_salary|one_time_bonus|threshold|tier|scheme_parameters), targetField,
oldValueJson, proposedValueJson, calculatedImpactKopeks?, effectiveFrom?, reason, regionalComment?,
status, revision, requestedById, requestedAt, reviewedById?, reviewedAt?, reviewerComment?,
returnedAt?, appliedAt?, appliedById?, rejectedAt?, cancelledAt?, historyJson, createdAt, updatedAt.
Статусы: draft, submitted, under_review, returned_for_revision, approved, rejected, cancelled,
applied, superseded. `@@unique` на applied override — один approved request → один applied result.

**`PayrollCalculation.approvedOverridesJson`** (аддитивно, nullable): approved-override
поверх base snapshot. Итог воспроизводим: `base snapshot + approved overrides + manual inputs`.
Исходный snapshot НЕ переписывается.

## Применение (§6)
- **one_time_bonus** → approved `PayrollAdjustment` (bonus) → gross через recompute. Денег/
  Expense/аванса не создаёт.
- **percentage/base_salary** → merge в `approvedOverridesJson` → повторный `computeScheme`
  (merged params + inputs) → новый `automaticAmountKopeks` → recompute. `EmployeePayScheme` и
  base snapshot не меняются. saveCalculationInputs тоже применяет overrides (воспроизводимость).
- **future_scheme_change** → после approve, если модель уже позволяет — новая effective-dated
  схема; иначе (полноценные versioned schemes = STAGE 12) — статус `approved_pending_scheme_
  creation` без небезопасной перезаписи. Не объявлять применённым, если схема не создана.

## Preview (§23)
`previewChangeImpact(schemeSnapshotParams, inputs, proposed)` — чистая; применяет override к
КОПИИ params, зовёт тот же `computeScheme`, возвращает current/proposed/difference/warnings/
affected breakdown. Preview и apply — один расчётный путь (никакого локального % в UI). Нет
базы/проблема → «Невозможно рассчитать влияние», не 0.

## Инварианты
- Pending request НЕ влияет на итог. Approve применяет ровно один раз (идемпотентно, unique).
- reject/return не меняют расчёт. Разовая корректировка не трогает live scheme. Будущая схема
  не переписывает прошлые. Закрытый период защищён; период с pending нельзя закрыть.
- Регионал не согласует свой запрос; всё server-side + tenant/club scope + IDOR-guard.

## Миграция
Только additive. `PayrollAdjustment`/snapshot/legacy-поля не трогаем. Backfill не нужен
(старых change request нет). Notes — `docs/migrations/payroll-change-request-migration.md`.

## Вне STAGE 10–11
OfdCashierMapping, авто-атрибуция, полноценные versioned schemes (STAGE 12), глобальный mobile
остальных модулей, изменение формул категорий.
