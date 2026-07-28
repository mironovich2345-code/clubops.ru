# Mobile readiness audit (CLUB-OPS)

Системный аудит мобильной готовности. Обязательный срок полной адаптации — **18 августа
2026**. В этом этапе **полностью адаптированы payroll и advances**; для остальных модулей —
приоритетный список проблем (не чиним сейчас, кроме payroll/advances).

Ширины проверки: 320 / 360 / 375 / 390 / 430 / 768 px. Роли: управляющий, регионал,
бухгалтер, owner/ГД.

Легенда: ✅ готов · 🟡 частично · 🔴 критично.

## Payroll и Advances — адаптированы в этом этапе

| Экран | Статус | Что сделано / осталось |
|---|---|---|
| `/payroll` (Обзор) | ✅ | KPI-сетка `grid-cols-2 sm:3 lg:5`, «Требуют внимания» — вертикальный список ссылок |
| Навигация ФОТ | ✅ | `PayrollNav` — горизонтальный скролл вкладок (`overflow-x-auto`) |
| `/payroll/periods` (список) | 🟡 | таблица в `overflow-x-auto`; фильтры переносятся. Карточный вид — follow-up |
| `/payroll/periods/[id]` | ✅ | 5 карточек `grid-cols-1 sm:2 lg:5`; ростер — карточки на mobile (`md:hidden`)/таблица (`md:block`) |
| Карточка расчёта сотрудника | 🟡 | вертикальные секции; поля через `CalculationCard`. Подробная формула — свернуть (follow-up) |
| `/payroll/advances` (список) | ✅ | карточки на mobile (`md:hidden`) + таблица (`md:block`); карточки-счётчики адаптивны |
| `/payroll/advances/[id]` (транши) | ✅ | одноколоночная; транши карточками; форма транша вертикальная, `inputMode=decimal`, touch ≥44px; «после выплаты остаток»; сторно визуально отделён (danger) + подтверждение |
| `/payroll/payments` | 🟡 | таблица в `overflow-x-auto`; карточный вид — follow-up |
| Форма создания аванса | ✅ | `AdvanceCreateForm` — `grid-cols-1 sm:2 lg:3`, кнопки ≥44px |

Мобильные требования §19 для payroll/advances: 5 карточек в колонку ✅; суммы/статусы без
горизонтального скролла ✅; таблицы сотрудников/траншей → карточки ✅; numeric-клавиатура
(`inputMode`) ✅; сторно отделён + подтверждение ✅; touch ≥44px ✅. Осталось (мелочь): свернуть
подробную формулу расчёта и sticky action bar с safe-area (в STAGE 14).

## Остальные модули — приоритетный список (не чиним сейчас)

| Модуль | Статус | Критичная проблема |
|---|---|---|
| Dashboard | 🟡 | плотные карточки/цифры на 320px; OFD-чипы переносятся ок |
| Invoices | 🔴 | широкие таблицы позиций/списка — горизонтальный скролл; форма загрузки |
| Expenses | 🔴 | таблицы + фильтры; модалки не влезают на 320 |
| Refunds | 🔴 | таблица + загрузка документов; действия теряются |
| Collections (Инкассация) | 🟡 | формы «Фактические деньги» — узко, но работоспособно |
| Payments (payroll) | 🟡 | таблица позиций (у управляющего скрыто — выплаты контекстные) |
| Payroll (управляющий) | 🟢 | упрощён до одного экрана: сегментированное меню «Зарплата/Долги» (≥44px), scope bar месяц/клуб с wrap, 5 карточек в одну колонку (`grid-cols-1`), ростер карточками — без горизонтального скролла от 320px |
| Employees | 🟡 | список ок; карточка сотрудника — длинные секции |
| Approvals/согласования | 🟡 | панель действий периода — кнопки могут переноситься |
| Analytics/ОФД | 🔴 | графики/таблицы не адаптированы |
| Settings/OFD | 🟡 | пошаговый экран Астрал — узкие формы, в целом ок |

Приоритет фиксов до 18.08.2026: **Invoices → Expenses → Refunds → Analytics → Dashboard →
Collections/Payments/Employees → Settings**. Детали и сроки — `docs/roadmaps/mobile-pwa-roadmap-2026-08-18.md`.

## Типовые проблемы (чек-лист для остальных модулей)
- Широкие таблицы (>5 колонок) → карточки на `md:hidden`.
- Модалки → full-screen sheet/drawer на узких.
- Denсные фильтры → перенос/скролл-строка.
- Числовые поля → `inputMode`/`type` для цифровой клавиатуры.
- Touch target ≥44px; кнопки согласования не теряются.
- Sticky/footer с `env(safe-area-inset-*)`.
- Ошибки рядом с полем; деструктивные действия — подтверждение.

## Обновление — WAVE 2 (2026-07-28)

Финансовый контур (расходы/счета/возвраты) адаптирован в рамках WAVE 2: списки → карточки,
встроенный doc-viewer, sticky-actions, тап-таргеты ≥44px, security-фикс перерасхода (реклама →
только ГД). Подробно: [mobile-wave2-finance-audit.md](mobile-wave2-finance-audit.md),
[отчёт](../testing/mobile-wave2-finance-report.md), [перф](mobile-wave2-performance.md).
Остатки (пагинация, stepper, calc-sticky, device-QA) — WAVE 3.

## Обновление — Навигация + Multi-account (2026-07-28)

Multi-account (несколько независимых аккаунтов на устройстве) + сгруппированный mobile drawer +
role-aware bottom nav доставлены. Density-пас визуальных страниц и sidebar-режимы — долг. Подробно:
[navigation-multi-account-visual-balance-audit.md](navigation-multi-account-visual-balance-audit.md),
[отчёт](../testing/navigation-visual-balance-report.md).

## Обновление — Density Pass Part 1 (2026-07-29)

Analytics/ОФД/Инкассация/Бюджеты/История уплотнены (density-система, tables→cards, filter-sheet,
single-accordion) + bottom-nav scroll-hide. Отчёт:
[mobile-visual-density-part1-report.md](../testing/mobile-visual-density-part1-report.md).
Остаток — Part 2 (breakdown-таблицы аналитики/ОФД, истории инкассации, остальные страницы).

## Обновление — Final mobile visual polish (2026-07-29)

Эмодзи убраны (SVG icon-set); нижнее меню удалено полностью (+dead-code); drawer/header/controls
bounded; company/club stack; employees → карточки. Отчёт:
[final-mobile-visual-polish-report.md](../testing/final-mobile-visual-polish-report.md). Остаток:
Button-variants, глубокий per-page pixel-polish, Playwright, реальный iPhone.
