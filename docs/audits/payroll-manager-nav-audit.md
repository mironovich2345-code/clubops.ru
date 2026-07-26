# Аудит: упрощение UX «Зарплата (ФОТ)» для управляющего

UX-упрощение и role-aware навигация. **Не** новый расчётный этап. Не трогаем формулы,
role_categories_v2, snapshot, approvedOverridesJson, PayrollChangeRequest, транши, выплаты,
долговый движок, state-machine, финансовые движения, close-guards, расчёты других ролей.

## Текущая карта payroll-навигации (`PayrollNav`)
| Пункт | Маршрут | Проблема для управляющего |
|-------|---------|---------------------------|
| Обзор | `/payroll` | Дублирует KPI шапки периода (§11) |
| Сотрудники и схемы | `/payroll/employees` | Параметры схем закрыты для управляющего (§8) |
| Расчётные периоды | `/payroll/periods` | Таблица всех периодов вместо одного экрана (§12) |
| Авансы | `/payroll/advances` | Дублирует 5-ю карточку периода (§9) |
| Выплаты | `/payroll/payments` | Должны быть контекстными (§10) |
| Долги | `/payroll/obligations` | **Оставляем** отдельным разделом (§6) |
| Согласования | `/payroll/change-requests` | STAGE 10–11; не в scope упрощения, скрываем у управляющего |
| Регионал | `/payroll/regional` | Расчёт зарплаты регионала — **полностью убрать** у управляющего (§7) |

Навигация — единый client-компонент `PayrollNav` с ХАРДКОД-списком (не зависит от роли).

## Текущее состояние экранов
- **`/payroll`** (`page.tsx`) — «Обзор»: month picker + 10 KPI-плиток + «Требуют внимания».
  Один на все роли.
- **`/payroll/periods/[id]`** — уже целевой рабочий экран: клуб · месяц · статус, шапка
  (Сотрудников/Начислено/К выплате/Требуют решения) + прогресс + 5 карточек
  (`PeriodCategoryCards`) + ростер (`PeriodRoster`) + «Согласование» (`PeriodWorkflowBar`) +
  кнопка «Сформировать». **Back-link «← Расчётные периоды»** ведёт в список.
- **`/payroll/regional`** — `requirePageAccess("payroll")` БЕЗ capability-гейта на VIEW →
  управляющий может открыть и **прочитать** начисления регионала (KPI, суммы). Мутации
  (`saveRegionalCityPayroll`/approve/cancel) гейтятся `canManagePaySchemes`.
- **`/payroll/obligations`** — долги, уже scoped по `clubIds` пользователя.

## Модель ролей / capability
`Role = owner | general_director | regional_director | manager | chief_accountant | accountant |
marketer`. Payroll-гейты (`src/lib/payroll/access.ts`): `canManagePayrollAssignments`
(regional|manager), `canManagePaySchemes` (owner|GD|regional|chief_accountant),
`canProposePayrollChange` (regional), `canReviewPayrollChange` (GD|owner). Страничный доступ —
`ROLE_PAGE_ACCESS["payroll"]` (owner/GD/regional/manager/accountant).

## Ответы на ключевые вопросы
1. **Кто «полная» навигация, кто «управляющий»?** Вводим `payrollNavMode(roles)`:
   `"full"` если есть любая из owner/GD/regional/chief_accountant/accountant; иначе если есть
   manager → `"manager"`. По capability, не по имени роли (§13).
2. **Где живёт основной экран управляющего?** На `/payroll` рендерим тот же рабочий экран
   (вынесенный в `PayrollWorkspace`), что и `/payroll/periods/[id]`. Никаких двух экранов с
   одинаковыми KPI (§11).
3. **Что при отсутствии периода?** Компактный empty-state: клуб, месяц, активных сотрудников,
   без схемы, с проблемами, кнопка «Создать период» (§3). Без таблицы всех периодов.
4. **Кто видит regional payroll?** `canViewRegionalPayroll(roles)` =
   owner|GD|regional_director|chief_accountant. **Не** manager, **не** обычный accountant.
   Server-side view-guard на `/payroll/regional` + подтверждение гейтов на всех regional actions
   (§7, §16). Regional city payroll — отдельная модель (`RegionalCityPayroll`), НЕ
   `PayrollCalculation`, поэтому «чужие employee calculations» тут не при чём; но добавляем
   явный guard и на страницу, и на действия.
5. **Долги.** Оставляем `/payroll/obligations` (реальная, scoped-страница) + добавляем алиас
   `/payroll/debts` → редирект на неё (сохраняя query). Nav «Долги» указывает на `/payroll/debts`.
6. **Старые маршруты (§15).** Для `manager`-режима: `/payroll/periods` → redirect `/payroll`,
   `/payroll/overview` (новый алиас) → `/payroll`, `/payroll/employees` → `/payroll`,
   `/payroll/payments` → `/payroll`, `/payroll/regional` → forbidden. `/payroll/advances`
   **сохраняем доступной** (открывается из 5-й карточки, это рабочий процесс аванса — §9;
   §15 разрешает «сохранить read-only/доступ»). Редиректы учитывают `month`/`club`/`periodId`.
   Для остальных ролей маршруты не трогаем. Циклов нет: `/payroll` (manager) рендерит workspace,
   не редиректит в periods.

## Что меняем (план)
1. Capability-хелперы + role-aware `PayrollNav`.
2. Вынести `PayrollWorkspace` (тело `periods/[id]`) + сделать `/payroll` лендингом управляющего.
3. Month/club switch (`PayrollScopeBar`) + empty-state create.
4. `/payroll/debts` алиас.
5. Regional server-guards.
6. Redirects/BC для manager.
7. Mobile 320px (5 карточек в колонку, segmented «Зарплата/Долги»).
8. Тесты `pilot:payroll-manager-simplified-ux` + docs.

## Не в scope
Изменения формул/снапшотов/финансов; переработка навигации других ролей; удаление старых
маршрутов (только редиректы/гейты). Payroll rework НЕ объявляется завершённым.
