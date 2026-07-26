# Приёмка: payroll role-cards STAGE 2 + STAGE 3–8

Реализованы STAGE 2 (классификация + резолвер) и STAGE 3–8 (подключение формул к
периоду + 5 карточек). Движок, статусы, права, финансовая логика, tenant isolation и
все существующие payroll-тесты сохранены. Транши аванса, согласование регионал→ГД,
OfdCashierMapping и финальная документация — вне этого этапа (STAGE 9–14).

## Что сделано

**Категории (STAGE 2).** `src/lib/payroll/categories.ts`: 8 **расчётных категорий**
(`club_manager, sales_manager, administrator, night_manager, gym_head_trainer,
gym_trainer, group_head_trainer, group_trainer`) ≠ 5 **UI-карточек**
(`manager_card, administrative_card, gym_trainers_card, group_trainers_card,
advances_card`). `payrollCategoryOfPosition` / `payrollUiGroupOfCategory`;
неизвестная должность → `unknown` (не даёт случайную формулу). Позиция
`sales_manager` добавлена в enum (аддитивно, position — строка, миграции не требует).

**Резолвер (STAGE 2).** `schemes.ts:resolveSchemeForCalc` — приоритет: сотрудник
(company+club+employeeId) → категория клуба (employeeId=null + position) →
`not_configured`. Учитывает дату периода (`resolveEffectiveScheme`). Никогда не берёт
схему чужого клуба/компании/категории. Несколько активных схем с одной датой начала →
`conflict` (расчёт блокируется, не выбирается случайно).

**Engine version (STAGE 3).** Аддитивная миграция
`PayrollCalculation.calculationEngineVersion` (`legacy_v1|role_categories_v2`,
default `legacy_v1`) — dev+prod, только ADD COLUMN. Старые расчёты остаются legacy_v1 и
не пересчитываются.

**Подключение формул (STAGE 4).** ЕДИНАЯ точка: `computeScheme` (compute.ts) направляет
`role_*` схемы в `role-compute.ts`, который вызывает чистые функции `formulas.ts`. Нет
параллельного движка. `generateCalculations` резолвит схему по приоритету, ставит
engineVersion, сохраняет snapshot параметров; `collectPeriodInput` читает входы всех 8
role-категорий; `CalculationCard` показывает поля по категории. Ничего не зашито —
все ставки/проценты/пороги/лимиты/оклады приходят из snapshot.

**Формулы (STAGE 5–8).** Значения проверены `pilot:payroll-formulas` (28). Управляющий —
АБ/ПТ отдельно, откл.×2, ±40%; администратор — ставка×смены (норма — контроль);
менеджер продаж — оклад/15 + тир-процент от общего плана клуба; ночной — тот же тир;
тренер ТЗ — новые/продления %, кредит информативен; старший ТЗ — тиры от плана ПТ;
тренер ГП — часы + личный %; старший ГП — +фикс +доля ГП. `role-compute` строит
расшифровку (breakdown) для каждой категории.

**5 карточек (STAGE 9-UI).** `PeriodCategoryCards` на странице периода: Управляющий /
Административный состав / Тренеры ТЗ / Тренеры ГП / Аванс — с числом сотрудников,
«заполнено X из Y», проблемами, предварительной суммой, статусом блока, «Открыть»
(фильтр ростера по группе; аванс → /payroll/advances). Прогресс «Расчёт заполнен на N из M».
Уволенные — не в активном составе; исторические остаются в snapshot периода.

## Тесты

`npm run pilot:payroll-role-cards-stage2` — **25** проверок: UI-группа ≠ категория,
админкарточка = 3 категории, ТЗ/ГП head+regular, unknown без формулы, sales_manager,
8 role-типов + валидация tiers, formulas в единой точке, резолвер приоритета,
generate+engineVersion+snapshot, входы всех категорий, поля карточки, 5 карточек,
кредит не в total, миграция аддитивна; реальная БД: employee>category, категория>fallback,
чужой клуб не используется, tenant isolation, конфликт блокирует, snapshot хранит params
+ engineVersion, живая схема не меняет snapshot, закрытый период не пересчитывается,
уволенный вне активного состава, исторический остаётся в периоде.

`pilot:payroll-formulas` 28 · `pilot:full` **2940/0** (55 сьютов, все старые payroll
проходят) · tsc ✓ · build ✓ · build:prod ✓ · схемы валидны.

## Осталось (STAGE 9–14)

Транши аванса (миграция + поток); корректировки регионала (change-request) → очередь
согласования ГД; versioned-схемы (version/status/approvedBy); OfdCashierMapping +
атрибуция возвратов; отдельные детальные вкладки категорий (§10–13) и mobile-полировка;
финальная документация (payroll-manager/regional/general-director/schemes-guide).

## Остаточные ограничения этапа

- Личная выручка/новые-продления вводятся ВРУЧНУЮ (OfdCashierMapping — STAGE 13). Явное
  хранение `source=manual/changedBy/changedAt/comment` для ручной выручки — в STAGE 8/13.
- Детальные вкладки внутри карточек (§10–13) пока показываются общим ростером,
  отфильтрованным по группе, со ссылкой в страницу расчёта сотрудника; выделенные
  пер-категорийные формы — следующий шаг.
- Пороги перехода между обычной/сниженной схемой управляющего (§3.1) задаются выбором
  версии схемы регионалом (versioned schemes — STAGE 12), не авто-выбором по плану.
