# Аудит: версионируемые схемы зарплаты (STAGE 12)

Аудит **до** изменения модели схем. Цель STAGE 12: после согласования будущего изменения
схемы ГД система создаёт новую безопасную версию `PayrollScheme`, не меняя использованные
ранее схемы и snapshot прошлых расчётов. Модель схемы — `EmployeePayScheme`.

Не в scope: OfdCashierMapping, авто-личная выручка, переработка формул, глобальный mobile,
Telegram, кадровые документы.

## 12 вопросов

1. **Как схема создаётся сейчас.** `savePayScheme` (`payroll/actions.ts`) — только
   **employee-specific** (форма требует `employeeId`). Валидирует params, ставит
   `effectiveFrom` = 1-е число месяца, `effectiveTo=null`, `createdByUserId`. Category-level
   схемы (`employeeId=null`, `position`) resolver поддерживает, но **UI их не создаёт**
   (появляются только в тестах/потенциальных seed). Схема создаётся **сразу действующей**
   (нет approval-статуса).
2. **Редактируется ли in-place.** Нет прямого редактирования параметров: `savePayScheme`
   только **append-forward** (Guard 2: новый `effectiveFrom` строго позже всех существующих).
   Единственный `update` — закрытие интервала (`effectiveTo`) супер­седнутой схемы в той же
   транзакции. Прямого `paramsJson`-update нет. Риск: нет server-guard, который бы явно
   запрещал такой update, если его добавят в будущем.
3. **Что с уже созданными периодами.** Каждый `PayrollCalculation` хранит immutable
   `schemeSnapshotJson` (`makeSchemeSnapshot`: `{schemeId, schemeType, params, effectiveFrom}`)
   и `calculationEngineVersion`. Пересчёт (`saveCalculationInputs`, aggregate) читает
   **snapshot**, не живую схему. Изменение схемы вперёд НЕ пересчитывает закрытый месяц.
4. **Как resolver выбирает.** `resolveSchemeForCalc({companyId, clubId, employeeId, position,
   at})`: (1) employee-specific при `effectiveFrom ≤ at < effectiveTo`; (2) club-category
   (`employeeId=null`, `position`); (3) `not_configured`. `resolveEffectiveScheme`: среди
   покрывающих окон побеждает наибольший `effectiveFrom`. `at` = **1-е число месяца периода**
   (`firstDay` в `generateCalculations`). Уже по дате периода, не today. ✔
5. **Какие поля effective-dated.** `effectiveFrom` (required), `effectiveTo` (nullable) —
   end-exclusive интервал (`from ≤ t < to`). Есть индекс `[clubId, effectiveFrom]`.
6. **Есть ли status/version/approvedBy.** **Нет.** Только `createdByUserId`. Нет `version`,
   `status`, `approvedById/At`, `submittedById/At`, `activatedAt`, `archivedAt`,
   `supersedesSchemeId`, `sourceChangeRequestId`, `payrollCategory`.
7. **Как employee перекрывает category.** Приоритет в `resolveSchemeForCalc`: сначала
   employee-rows, при наличии действующей — возвращается `level:"employee"`; иначе
   category-rows → `level:"category"`. Оба запроса полностью scoped по company+club.
8. **Как определяются конфликты.** `hasSchemeConflict`: ≥2 покрывающих окна с ОДИНАКОВЫМ
   максимальным `effectiveFrom` → `conflict` (блокирует расчёт). Частичные пересечения
   разных `effectiveFrom` сейчас НЕ считаются конфликтом (побеждает больший from) — при
   версионировании их нельзя допускать (интервалы не должны пересекаться).
9. **Какие старые схемы уже использованы в snapshot.** Любая схема, чей `id` встречается в
   `PayrollCalculation.schemeSnapshotJson.schemeId`. Backfill-audit должен их вычислить и
   пометить immutable.
10. **Что потребует миграции.** Аддитивно добавить в `EmployeePayScheme`: `version`,
    `status`, `payrollCategory`, `submittedById/At`, `approvedById/At`, `activatedAt`,
    `archivedAt`, `supersedesSchemeId`, `sourceChangeRequestId` (unique), `comment`. Плюс
    backfill существующих строк (version=1, status по датам). Snapshot — JSON, схему БД не
    меняет; обогащается новыми ключами (version, level, sourceChangeRequestId, resolvedAt).
11. **Как конвертировать approved_pending_scheme_creation.** `PayrollChangeRequest` с
    `requestType=future_scheme_change` после approve уходит в `approved_pending_scheme_
    creation` (в `approveChangeRequest`, ветка future). STAGE 12: `materializeApproved
    SchemeChange(requestId)` — идемпотентно создаёт новую версию из `proposedValueJson` +
    `effectiveFrom`, закрывает интервал предыдущей, ставит `sourceChangeRequestId`, помечает
    request `applied`. Уникальность `sourceChangeRequestId` гарантирует один результат.
12. **Где риск пересчёта истории.** (а) закрытие `effectiveTo` старой версии — допустимо
    (интервал), но `paramsJson` менять нельзя; (б) resolver по дате периода — безопасен; (в)
    silent refresh открытого периода — **не делать**; только явное действие с preview/guard.
    Snapshot неизменяем.

## Целевые решения (кратко)
- **Logical scheme key** = `(companyId, clubId, employeeId ?? "ALL", position)` — та же
  группировка, что и в resolver. `version` инкрементируется в пределах ключа (не глобальный
  max). `payrollCategory` (nullable) — производное от `position` для отображения/валидации.
- **Интервалы**: end-exclusive `from ≤ t < to` (текущий стандарт) — фиксируем. При активации
  новой версии предыдущей открытой ставим `effectiveTo = newEffectiveFrom`.
- **Статусы**: `draft | pending_approval | approved | scheduled | active | superseded |
  archived | rejected | cancelled`. Resolver учитывает ТОЛЬКО «живые» статусы
  (approved/scheduled/active/superseded) + дату; draft/pending/rejected/cancelled/archived не
  участвуют. Активность вычисляется по дате+статусу, не по потенциально устаревшему `status`.
- **Materialize**: идемпотентно (`sourceChangeRequestId @unique`); повтор возвращает
  существующую версию; сбой не помечает request `applied`.
- **Immutability**: для used/active/superseded запрещён change `paramsJson/payrollCategory/
  employeeId/clubId/companyId/effectiveFrom/version/schemeType`; можно только `effectiveTo`
  (корректный supersede), `status`, служебные timestamps, archive-метаданные.
- **Backfill**: аддитивный, dry-run по умолчанию, `--apply` явно; used-схемы immutable;
  неоднозначные → manual review, не угадывать.

## Не менять
Формулы, role_categories_v2, snapshot прошлых расчётов, финансовую логику, PayrollChangeRequest
(кроме materialize-хука), STAGE 9 транши. Payroll rework НЕ объявляется завершённым.
