# Отчёт: упрощение UX «Зарплата» для управляющего

UX-упрощение + role-aware навигация. Не менялись: формулы (`formulas.ts`,
role_categories_v2), scheme snapshot, `approvedOverridesJson`, `PayrollChangeRequest`,
STAGE 9 транши, выплаты, долговый движок, state-machine, финансовые движения, close-guards,
legacy_v1, расчёты других ролей.

## Что было перегружено
Единый `PayrollNav` из 8 хардкод-вкладок (Обзор / Сотрудники и схемы / Расчётные периоды /
Авансы / Выплаты / Долги / Согласования / Регионал) показывался всем ролям одинаково. `/payroll`
был техническим «Обзором», дублирующим KPI шапки периода. Управляющий видел таблицу всех
периодов и мог открыть расчёт зарплаты регионала.

## Что сделано
1. **Role-aware навигация по capability** (`payrollNavMode`): чистый управляющий → режим
   `manager` (сегментированный контрол **Зарплата + Долги**); owner/GD/regional/бухгалтер →
   `full` (прежний тулбар).
2. **Один рабочий экран** (`PayrollWorkspace`, вынесен из `periods/[id]`): рендерится и на
   `/payroll` (лендинг управляющего), и на `/payroll/periods/[id]` (для остальных ролей).
3. **`/payroll` role-aware**: управляющему сразу рабочий период выбранного месяца; при
   отсутствии — компактный empty-state с созданием. Остальным — прежний обзор.
4. **Переключение месяца/клуба** (`PayrollScopeBar`) + empty-state create (`PayrollEmptyPeriod`).
5. **`/payroll/debts`** — стабильный вход «Долги» (→ club-scoped `/payroll/obligations`).
6. **Regional payroll закрыт управляющему** server-side: `canViewRegionalPayroll` (без
   `manager`) на странице (`notFound`) и на действиях выплат.
7. **Редиректы** для управляющего: `periods` / `employees` / `payments` / `summary` /
   `overview` → `/payroll` (с сохранением month/club).
8. **Mobile от 320px**: 5 карточек в колонку, сегментированное меню из 2 пунктов ≥44px,
   scope bar с wrap без горизонтального скролла.

## Ответы на пункты финального отчёта (§21)
1. **Перегружено:** 8 одинаковых вкладок + отдельный обзор-дубль + доступ к регионалу.
2. **Скрыто у управляющего:** Обзор, Сотрудники и схемы, Расчётные периоды, Авансы, Выплаты,
   Согласования, Регионал (как отдельные разделы).
3. **`/payroll` теперь:** рабочий экран выбранного месяца (5 карточек + ростер + согласование).
4. **Месяц:** `‹ Месяц ›` + select + выбор клуба (при нескольких), query `month`/`club`.
5. **Без периода:** empty-state (клуб, месяц, активных, без схемы) + «Создать период» →
   возврат на рабочий экран.
6. **5 карточек:** Управляющий / Административный состав / Тренеры ТЗ / Тренеры ГП / Аванс.
7. **Авансы:** 5-я карточка периода → `/payroll/advances[/id]`; отдельной вкладки нет.
8. **Выплаты:** контекстно (карточка расчёта/аванса/долги/история); отдельной вкладки нет.
9. **Долги:** отдельный пункт `/payroll/debts` → `/payroll/obligations`, только свой клуб.
10. **Регионал убран:** нет вкладки/ссылок; `canViewRegionalPayroll` → `notFound` на странице
    и запрет в `recordRegionalCityPayment`/`cancelRegionalCityPayment`.
11. **Server-side guards:** view-guard регионала; regional actions по capability; редиректы
    скрытых разделов на сервере (SSR), не только в UI; club/tenant-scoping выборок сохранён.
12. **Старые URL:** `periods`/`employees`/`payments`/`summary`/`overview` → redirect `/payroll`;
    `regional` → `notFound`; `advances` — сохранён (вход из карточки, §9). Циклов нет.
13. **Другие роли:** полный тулбар и все разделы сохранены; регионала видят
    owner/GD/regional/бухгалтеры.
14. **Mobile:** одна колонка, 2-кнопочное меню, ≥44px, без горизонтального скролла (320–768px).
15. **Тесты/build:** `pilot:payroll-manager-simplified-ux` 33/0; tsc/next build/build:prod/
    prisma validate dev+prod зелёные; `pilot:full` зелёный.
16. **Commit hashes:** см. `git log` (серия `feat/test/docs(payroll): … item N`).
17. **Остаточные ограничения:** `/payroll/advances` остаётся доступной управляющему как
    рабочий процесс аванса (вход из карточки), а не редиректится — сознательное решение по §9.
    Долги физически по маршруту `/payroll/obligations` (алиас `/payroll/debts`). Payroll rework
    в целом **не** объявляется завершённым.

## Тесты
`npm run pilot:payroll-manager-simplified-ux` — 33 проверки (5 pure + 23 static guards + 5
real-DB scope/IDOR/tenant). Зарегистрирован в `pilot:full`.
