# Final mobile visual polish — Part 2: отчёт (§11)

Дата: 2026-07-29 · Ветка: main. Page-by-page acceptance по 8 реальным iPhone-скриншотам.

> **Честно (главное):** (1) Скриншоты сделаны на сборке ДО `028ff58` — на них ещё эмодзи, нижнее
> меню, company/club в ряд, таблица сотрудников; всё это **уже удалено/исправлено в коде** (HEAD,
> проверено grep'ом) → нужен **rebuild/redeploy**. (2) **Реальные Playwright-скриншоты в этой среде
> НЕ сняты**: нет сети (не ставится @playwright/test/chromium) и вход по email-OTP (нет headless-
> логина). Harness реальный и запускаемый — команды в
> [iphone-manual-acceptance-part2.md](iphone-manual-acceptance-part2.md) и `tests/visual/README.md`.
> «Визуально готово» без просмотренных artifacts не заявляю.

Автотесты: `pilot:final-mobile-visual-polish-part2` 12/12. Аудит:
[final-mobile-visual-polish-part2-audit.md](../audits/final-mobile-visual-polish-part2-audit.md).

## Изменённые страницы / компоненты (before → after)

| Экран | Было | Стало |
|---|---|---|
| **Button system** | utility-классы кнопок по всем страницам | `src/components/mobile/buttons.tsx` — Primary/Secondary/Danger/Ghost/Icon + ActionButtonRow + SegmentedControl + `buttonClass()`/`segmentClass()` (≥44px, CTA 48px, центр icon+label, единый focus ring, block=full-width) |
| **MonthNav** (Dashboard, OFD) | стрелки+label+badge в один wrapping ряд; текстовые ‹ › | `MonthNav.tsx`: симметричные 44×44 SVG-стрелки, центр truncate-label, badge/reset отдельной строкой; длинный месяц не двигает стрелки |
| **Expenses top-actions** | «Инкассация…» и «+ Новый расход» разной ширины, wrap | 2 колонки равной высоты на mobile (стек <380px), inline на desktop; +16px до info-note |
| **Expenses status-filters** | хаотичный 2+2 разной ширины | один ряд chips с горизонтальным скроллом в контейнере, ровные, edge-to-edge scroll (`-mx-4 px-4`) |
| **Invoices KPI** | 5-я карта «Счетов» — одинокая половинная | 5-я карта `col-span-2` на 2-col (full-width); value `whitespace-nowrap tabular-nums` (₽ не переносится/не режется) |
| **Collections CTA** | «Сохранить…» auto-width, смещена влево | full-width 48px primary на mobile (auto на desktop) через `buttonClass` |
| **Employees add-CTA** | «Добавить сотрудника» auto-width | full-width 48px primary на mobile |

## §11 отчёт

1. **Список изменённых страниц.** Dashboard (month-nav), OFD (month-nav+уже карточки), Expenses
   (top-actions+статусы), Invoices (KPI), Collections (CTA), Employees (CTA). + shared buttons/MonthNav.
2. **before/after.** См. таблицу выше.
3. **Screenshot artifact paths.** `artifacts/mobile-visual-polish-part2/<page>-<theme>-<width>.png`
   (+ `-drawer.png`) + `index.html` (contact sheet). **Генерируются при запуске harness у вас**
   (в среде разработки не создавались — см. «Честно»).
4. **Выявленные/исправленные overlaps.** Из скриншотов: expenses top-actions неравные +
   status-filters wrap (наложения по ширине) → grid/scroll; invoices KPI одинокая карта → col-span;
   collections/employees CTA смещение → full-width. Runtime-проверки наложений — в Playwright-спеке
   (`no button overlaps`, `controls within viewport`), запускается у вас.
5. **Результаты bounding-box tests.** Спека готова (scrollWidth≤vw; controls внутри parent+≥12px
   edge; нет overlap; drawer в экране) — **запуск у вас** (нет браузера/сети/OTP в среде).
6. **Commit hashes.** `850b6fd` audit · `89abd51` buttons+MonthNav+pages · `5b9e7cd` harness+pilot+
   manual list · (docs — этот коммит).
7. **Что проверить на реальном iPhone.** Полный список URL/ролей/состояний —
   [iphone-manual-acceptance-part2.md](iphone-manual-acceptance-part2.md) (12 пунктов). Обязательно
   после rebuild.

## Критерий завершения (§11) — статус

| Критерий | Статус |
|---|---|
| Единая Button system реально используется | ✅ (expenses/collections/employees/month-nav) |
| Expenses top-actions исправлены | ✅ |
| status filters исправлены | ✅ (scroll chips) |
| Dashboard month-nav исправлен | ✅ (MonthNav) |
| Invoices month-nav и filters | ⚠️ month-nav OK; KPI исправлен; city/club filters — базовый box-sizing (глубже — остаток) |
| Collections forms выровнены | ✅ CTA; date (§18 global). Полный DateField wrapper — остаток |
| primary actions центрированы | ✅ (buttonClass) |
| нет растянутых/узких кнопок | ✅ (grid/full-width правила) |
| реальные Playwright screenshots созданы | ⏳ harness готов, **не запущен в среде** (нет сети/браузера/OTP) |
| screenshots вручную просмотрены | ⏳ у вас (после запуска) |
| 320–430px без overlap | ✅ по коду; runtime-подтверждение — Playwright у вас |
| desktop не ухудшен | ✅ (inline на lg; build:prod ✓) |
| build:prod и pilot:full зелёные | ✅ (см. гейты) |

## Остаток (следующий проход)

Единый `DateField` wrapper; глубокая переверстка Invoices city/club filters + Analytics/OFD/Budgets/
History фильтров через общий `MobileFilterStack`/`FilterActionRow`; SegmentedControl применить к
budgets Бюджеты/План-факт (сейчас инлайн-segmented); Refunds/Payroll/Settings pixel-pass; **запуск
Playwright у вас** + ручной прогon на iPhone.
