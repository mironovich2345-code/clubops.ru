# Final mobile visual polish — аудит

Дата: 2026-07-29 · Ветка: main. Цель: довести mobile до визуально готового продукта (без новых
бизнес-функций, без изменения формул/прав/статусов/расчётов/tenant/multi-account/server actions/
маршрутов).

> **Честно про источник:** скриншоты к этому этапу не приложены к сообщению. Аудит проведён по
> реальному коду (я его знаю) + перечню дефектов из ТЗ. Пиксельная проверка на реальном iPhone и
> Playwright-скриншоты — отдельно (чек-лист + сетап; из окружения разработки не выполнимо вживую).

## A. Эмодзи (полный инвентарь — node-скан)

Убрать (заменить единым inline-SVG icon-set, не текстовыми символами):
- **`src/lib/navigation.ts` NAV_ICONS** — 18 эмодзи (🗂🏠📊🧾💸💵📄📆📌🏦👥💰↩️🎯📁🕘🔑⚙️). Используются
  в mobile drawer (и в bottom nav, которая удаляется).
- **`src/components/mobile/MobileFileField.tsx`** — 📷 📎.
- **`src/components/mobile/MobileListCard.tsx`** — ➜ (actor), 📎 (docs).
- **`src/components/BudgetFactTable.tsx`** — 🟢🟡🔴 (лейблы статусов лимита).
- Структурные глифы-как-иконки → в SVG для единой системы: `MobileShell` ☰ (меню), `Sheet`/`DocumentViewer`/
  `MobileFileField` ✕ (закрыть), `FilterSheet` ⚙ (фильтр), `density.InfoNote` ℹ.
- PWA manifest shortcuts — проверить/убрать эмодзи из `src/app/manifest.ts`.

Плоские текстовые ✓/⚠ в payroll/refunds/sales — не цветные эмодзи (dingbats); вне mobile-polish-
скоупа (payroll/sales), не трогаем в этом этапе, кроме 🟢🟡🔴 (цветные). Static guard запретит
цветные эмодзи в `navigation.ts` + `src/components/mobile/**`.

## B. Нижнее меню (удалить полностью, не CSS-hide)

`src/app/(app)/_components/MobileShell.tsx` — `fixed bottom-0` nav (primary + «Ещё»), role-aware
`bottomOrder`, scroll-hide (`useHideOnScrollDown`), suppression store (`useChromeSuppressed`).
Связанный dead-code после удаления: `bottomNavOrder`/`bottomNavOrderForRole`/`BOTTOM_NAV_BY_ROLE`
(navigation.ts), `navigation-server.bottomNavOrder`, `mobile-chrome.ts` (hook+store — используются
ТОЛЬКО bottom nav и StickyActions/Sheet для её скрытия), `.pb-bottom-nav` (globals.css) + `pb-bottom-nav`
в layout `<main>`. Пилоты, ассертящие bottom nav (SH4, BN1-5, N5-7) — обновить/удалить. Навигация на
mobile остаётся: sticky top header + hamburger + drawer + context-кнопки + back-links.

## C. Постранично (15 метрик; из кода + ТЗ)

| Стр. | Эмодзи | Выход за контейнер / overflow / наложение | Кнопки/выравнивание | Таблица сжата |
|---|---|---|---|---|
| **Drawer** | NAV_ICONS emoji | company/club — 2 `<select>` в ряд могут выходить; ширина не bounded | account/тема/безопасность плотно | — |
| **Dashboard** | — | month nav может растягиваться; badge | arrows разного вида; sync-кнопка | — |
| **Expenses** | — | — | 2 top-кнопки (Инкассация/Новый) + status-пилюли переносятся неравномерно | нет (WAVE-2 cards) |
| **Collections** | — | **date input визуально шире card** (box-sizing) | CTA узкая/смещена; native upload | истории — скролл-таблица (свёрнуты) |
| **Invoices** | — | city/club фильтры; KPI 5-я карточка «половинная» | — | нет (WAVE-2 cards) |
| **Employees** | — | **wide desktop table на mobile** (уходит вправо) | add-форма; фильтры | **да → нужны карточки** |
| **Analytics** | — (KpiCard clamp ok) | breakdown-таблицы (Part-2) | период-форма | breakdown (Part-2) |
| **OFD** | — | — (Part-1 cards) | month switcher | статьи (Part-2) |
| **Budgets** | 🟢🟡🔴 в BudgetFactTable | — (Part-1 cards) | segmented ok | plan-fact table |
| **History** | — | — (Part-1 cards + FilterSheet) | — | — |
| **Payroll** | ✓/⚠ текст (не цвет) | вне скоупа | вне скоупа | вне скоупа |
| **Refunds** | ➜📎 (в MobileListCard) | — | — | нет (WAVE-2) |
| **Settings** | — | проверить формы | — | — |

## D. Общие правила (цели)

- Единый icon-set (одна толщина/размер, aria-hidden декоративным, label icon-only кнопкам).
- Mobile header — симметричная grid `44px / 1fr / 44px`; hamburger 44×44 стабильный.
- Drawer — `w-[min(88vw,360px)]`, `overflow-x-hidden`, `min-w-0` детям, controls `w-full`.
- Company/club — вертикальный stack (или единый context-sheet), `w-full`, truncate.
- Кнопки — единые варианты (primary 48px/secondary 44px, radius/padding/gap единые); ряд из 2 →
  `grid grid-cols-2 gap-3` со стеком на узком; 3+ → primary + меню.
- Inputs/select/date — `w-full max-w-full min-w-0 box-sizing:border-box`, ≥16px, 48–52px, chevron
  не перекрывает текст, long value truncate. Date input не шире родителя.
- Единые page-отступы (px-4; section gap; card padding 12–16).
- Employees desktop-table → mobile cards.
- File upload — единый `MobileFileField` (без сырого native layout).

## E. Критерии завершения (§27)

Нет эмодзи; нижнее меню удалено (не спрятано); drawer/controls в экране; кнопки не накладываются и
единообразны; фильтры с одинаковыми безопасными отступами; date/select/file не выходят за карточки;
primary actions аккуратны; wide-tables на mobile нет; header одинаков; 320–430px без дефектов; light/
dark целостны; desktop не ухудшился; ручной iPhone-чек-лист + Playwright просмотрены.

## F. Вне скоупа / долг

Пиксельная переверстка payroll/dashboard/settings глубоко; полная замена ✓/⚠ текст-глифов; Analytics/
OFD breakdown-таблицы (Part-2); реальный прогон на iPhone. Зафиксировано в отчёте.
