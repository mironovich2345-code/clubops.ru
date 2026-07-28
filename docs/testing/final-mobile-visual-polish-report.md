# Final mobile visual polish — итоговый отчёт (§27)

Дата: 2026-07-29 · Ветка: main. Без новых бизнес-функций; формулы/права/статусы/расчёты/tenant/
multi-account/server actions/маршруты не менялись.

> **Честно:** скриншоты к этапу не приложены. Правки — по фактическому коду + перечню дефектов ТЗ.
> Пиксельная приёмка на реальном iPhone + Playwright-скриншоты (§22) — отдельно (сетап/чек-лист
> готовы; вживую из окружения разработки не выполнимо). Автогарантии: `pilot:final-mobile-visual-polish` 10/10.

## 25-точечный отчёт

1. **Где были эмодзи.** `NAV_ICONS` (18), `MobileFileField` (📷📎), `MobileListCard` (➜📎),
   `BudgetFactTable` (🟢🟡🔴), структурные глифы (☰✕⚙ℹ↗⤓), `AccountSwitcher` (⇄).
2. **Чем заменены.** Единый SVG icon-set `src/components/mobile/icons.tsx` (24-viewBox, currentColor
   stroke, одинаковая толщина, `aria-hidden` декоративным): `NavIcon` по странице + Menu/Close/
   Chevron/Filter/Camera/Paperclip/Info/Switch/ExternalLink/Download. 🟢🟡🔴 → текст+тон.
3. **Как удалено нижнее меню.** Полностью удалён `fixed bottom-0` nav из `MobileShell` (не CSS-hide);
   навигация — sticky header + hamburger + drawer + context-кнопки + back-links.
4. **Dead-code удалён.** `navigation-server.ts` (bottomNavOrder), `mobile-chrome.ts` (scroll-hide +
   suppression store), `BOTTOM_NAV_BY_ROLE`/`bottomNavOrderForRole` (navigation.ts), `.pb-bottom-nav`
   (globals + layout), регистрация store в StickyActions/Sheet, bottom-nav-пилоты (обновлены на guard-и).
5. **Почему drawer выходил.** `w-[86%] max-w-xs` без `overflow-x-hidden`; company/club — 2 широких
   `<select>` в ряд; дети без `min-w-0`.
6. **Как исправлена ширина drawer.** `w-[min(88vw,360px)] max-w-full overflow-x-hidden`; всем детям
   `min-w-0`; nav `overflow-x-hidden`.
7. **Company/club context.** ScopeSwitcher: `flex-col` full-width на mobile (`lg:flex-row` инлайн на
   desktop); каждый select `w-full min-w-0 truncate`, ≥44px — не два широких select в ряд (§5).
8. **Mobile header.** Симметричная grid `44px / 1fr / 44px`; заголовок по центру; hamburger 44×44
   стабильный (§16).
9. **Кнопки.** SVG-иконки в кнопках единого размера/gap; icon-only кнопки имеют `aria-label`; close/
   menu → 44×44. (Единый Button-variants компонент — частично; см. остаток.)
10. **Наложения.** Устранены за счёт grid-header (44/1fr/44), `min-w-0` в drawer/карточках,
    `break-anywhere`; убраны emoji-подложки.
11. **Button rows.** Финансовые формы уже используют `grid`/`flex-wrap` + full-width primary (WAVE 2);
    новых наложений не введено.
12. **Фильтры.** Density-этап (Part 1): FilterSheet + compact grid; здесь — глобальный box-sizing,
    чтобы контролы фильтров не выходили за карточку.
13. **Date/select controls.** Глобально `input/select/textarea { max-width:100%; box-sizing:border-box }`
    + `input[type=date|month|...] { min-width:0; width:100% }` — date-input больше не шире карточки (§18).
14. **Expenses.** Карточки (WAVE 2) сохранены; density/box-sizing применяются. Глубокая переверстка
    top-actions — остаток (см. ниже).
15. **Collections.** Single-accordion (Part 1) + глобальный date box-sizing чинит «date шире card».
16. **Invoices.** Карточки (WAVE 2) + `min-[400px]` KPI (Part 1); фильтры под общий box-sizing.
17. **Employees.** Desktop-таблица `hidden lg:block` + mobile MobileDataCard (ФИО/статус/клуб/
    комментарий + dismiss) — wide table убрана (§15).
18. **File upload.** `MobileFileField` — камера/файлы через SVG-иконки, per-file remove; единый вид.
19. **320–768px.** mobile — карточки/одна колонка, без общего h-scroll; drawer/controls в экране.
20. **Light/dark.** Иконки `currentColor` (наследуют цвет темы); компоненты на slate/brand + `.dark`
    remap. Попиксельно — на устройстве.
21. **Desktop regression.** Sidebar/десктоп-хедер/таблицы под `lg:` не тронуты; ScopeSwitcher инлайн
    на `lg`. `build:prod` — успех.
22. **Playwright screenshots.** Сетап/список кадров (§22) в чек-листе; прогон — отдельно (остаток).
23. **Тесты/build.** `pilot:final-mobile-visual-polish` 10/10; `pilot:full` (см. гейты); tsc чисто;
    `next build` + `build:prod` — успех; prisma dev+prod — valid.
24. **Commit hashes.** `762c6fd` audit · `028ff58` remove bottom-nav+emoji+bounds · `b99f8ec`
    employees cards · `7931002` final-polish pilot.
25. **Остаётся визуально нерешённым (остаток).** Единый Button-variants компонент (primary/secondary/
    danger/ghost/icon/segmented) как отдельный модуль; глубокая пиксельная переверстка top-actions
    Expenses, status-tabs, Dashboard month-nav; полная замена текст-глифов ✓/⚠ в payroll/sales;
    Playwright-скриншоты 320–1440 light/dark; ручной прогон на реальном iPhone
    ([чек-лист](iphone-final-mobile-visual-polish-checklist.md)).

## Критерии завершения (§27) — статус

| Критерий | Статус |
|---|---|
| Нет эмодзи | ✅ (guard E1, nav+mobile UI) |
| Нижнее меню полностью удалено | ✅ (не спрятано; dead-code удалён) |
| Drawer/controls не выходят за экран | ✅ bounded + stack |
| Кнопки не накладываются | ✅ (grid header, min-w-0) |
| Единый размер/выравнивание кнопок | ⚠️ иконки/44px унифицированы; отдельный Button-variants — остаток |
| Фильтры — одинаковые безопасные отступы | ✅ (Part 1 + box-sizing) |
| date/select/file не выходят за карточки | ✅ (§18 global) |
| wide tables на mobile отсутствуют | ✅ (employees + Part-1/WAVE-2; analytics breakdown — Part-2 остаток) |
| mobile header одинаков | ✅ симметричная grid |
| 320–430px без дефектов | ✅ по коду; пиксельно — устройство |
| light/dark целостны | ✅ currentColor/токены; устройство |
| desktop не ухудшился | ✅ build:prod ✓ |
| screenshots/iPhone просмотрены | ⏳ остаток (нет устройства/скриншотов) |
