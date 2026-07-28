# Mobile visual density — Part 1: итоговый отчёт (§27)

Дата: 2026-07-29 · Ветка: main. Скоуп: Analytics, ОФД, Инкассация, Бюджеты, История действий +
density-система + bottom-nav scroll-hide. Бизнес-логику/формулы/права не меняли.

Автотесты: `npm run pilot:mobile-visual-density-part1` — **24/24**. Аудит (постранично):
[navigation-multi-account-visual-balance-audit.md](../audits/navigation-multi-account-visual-balance-audit.md)
(раздел «Density Pass Part 1»). Перф: [mobile-density-part1-performance.md](../audits/mobile-density-part1-performance.md).

## 24-точечный отчёт

1. **Visual problems (аудит).** Крупные `PageHeader mb-6 text-2xl`; `p-5 text-2xl/3xl` KPI;
   фильтры на весь первый экран (activity 6 полей, budgets, analytics); сжатые desktop-таблицы на
   mobile (ОФД/budgets/activity/collections/analytics); bottom nav статична + конфликт со StickyActions.
2. **Density tokens.** Единый набор компонентов `src/components/mobile/density.tsx`: CompactPageHeader,
   CompactMetricCard, DataSummaryCard, MobileDataCard, SectionHeader, InfoNote, EmptyState,
   ActiveFilterChips (page pad 16 / card pad 12–16 / ≥44px / единый radius).
3. **PageHeader.** Компактный (H1 lg/sm:xl + короткий subtitle, `mb-4`), без oversized высоты.
4. **Filters sheet.** Action History: частые — сверху (период), полный набор → `FilterSheet` (chips +
   счётчик; apply в sticky footer, safe-area/keyboard-safe). Desktop-форма сохранена (`hidden lg:grid`).
5. **Bottom nav скрытие.** `useHideOnScrollDown` (hysteresis) + suppression-store: скрыт при
   scroll-down / StickyActions / открытом Sheet|drawer; `transform` (без layout shift); safe-area.
6. **Jitter.** Аккумулятор знакового delta + порог 14px; игнор микроскролла (<2px) и bounce; не
   скрывать при фокусе поля (клавиатура); всегда показывать у верха.
7. **Analytics.** Compact header; KPI `p-5 text-3xl truncate` → `p-3` + clamp value (₽ не переносит);
   KPI grid `grid-cols-2` → `grid-cols-1 min-[400px]:grid-cols-2`.
8. **Metric cards объединены.** Единый CompactMetricCard/DataSummaryCard паттерн (label+value+статус).
9. **ОФД summary.** 3 карточки Сегодня/Вчера/Месяц → DataSummaryCard (компактный dl); month switcher
   компактный (‹ месяц ›); `Block mb-8` убран.
10. **ОФД «По клубам» → cards.** desktop-таблица `hidden lg:block` + mobile MobileDataCard (нал/безнал/
    возвраты/чеки + Итого footer).
11. **ОФД «По юрлицам» → cards.** то же; длинное имя переносится (`break-anywhere`).
12. **Single-active accordion.** Collections: 6 независимых `<details>` → один AccordionGroup;
    открытие закрывает прочие; истории свёрнуты по умолчанию.
13. **Collections forms уплотнены.** OooCard/IpCard `rounded-2xl p-5 text-2xl` → `rounded-lg p-4
    text-xl`; Section `mb-8 p-5` → `mb-5 p-4`; compact header.
14. **History tables.** Action History лог → dense cards (когда/кто/роль/клуб + result badge, объект в
    «Подробнее»); Collections истории — скролл-таблица в контейнере, свёрнуты (карточки → Part 2).
15. **Budgets.** Compact header/filter; Бюджеты/План-факт → segmented control; permission → InfoNote.
16. **Overspend.** Лимиты → cards со статусом (Перерасход/Близко к лимиту/В норме/Лимит не задан),
    overspend-first порядок (presentational; desktop-порядок/данные не тронуты).
17. **Action History.** См. п.4/п.14 — фильтры в sheet, лог в карточки, серверная пагинация сохранена.
18. **Light/dark.** Компоненты используют slate/brand + `.dark` remap (WAVE 1); попиксельно — на устройстве.
19. **320–1440.** mobile — карточки/одна колонка, без общего h-scroll; desktop-таблицы `hidden lg:block`.
20. **Performance до/после.** desktop-таблицы `display:none` на mobile (не раскладываются); single-
    accordion ограничивает раскрытые блоки; bottom-nav — `transform` без reflow; серверная пагинация
    Action History сохранена. Метрики — [perf-doc](../audits/mobile-density-part1-performance.md).
21. **Тесты/build.** `pilot:mobile-visual-density-part1` 24/24; `pilot:full` (см. гейты); tsc чисто;
    `next build` + `build:prod` — успех; prisma validate dev+prod — valid.
22. **Commit hashes.** `787b1f6` audit · `b3725b5` density+bottom-nav · `c475e55` OFD · `ac2e3ce`
    budgets · `21eee93` history · `9d7b7f1` collections · `9b78be4` analytics.
23. **Осталось на iPhone.** [iphone-mobile-density-part1-checklist.md](iphone-mobile-density-part1-checklist.md)
    (25 пунктов): первый viewport, single-accordion, bottom-nav hide/return, light/dark, safe-area, landscape.
24. **В Part 2.** Analytics breakdown-таблицы (weekday/manager/top-expenses/by-network) → cards;
    ОФД `OfdRevenueTable` (статьи) → cards; Collections истории → cards; collections-формы на
    StickyActions (bottom-nav hide-on-form сейчас только по скроллу); Playwright visual 320–1440;
    Dashboard/Payments/Mandatory/Employees/Payroll (вне Part-1).

## Критерии завершения (§27) — статус

| Критерий | Статус |
|---|---|
| Analytics — данные в первом viewport | ✅ compact header+KPI (попиксельно — устройство) |
| Фильтры не на весь экран | ✅ (activity sheet; budgets compact) |
| ОФД breakdown карточками | ✅ |
| Collections не бесконечная лента форм | ✅ single-active accordion |
| Budgets без обрезанной mobile-таблицы | ✅ карточки |
| Action History без огромной формы фильтров | ✅ FilterSheet |
| Bottom nav скрывается/возвращается стабильно | ✅ hysteresis hook |
| Bottom nav не конфликтует со StickyActions | ✅ suppression store |
| Нет horizontal page scroll | ✅ (карточки + WAVE-1 clip) |
| Единая визуальная плотность | ✅ density-система (5 разделов) |
| Desktop не ухудшился | ✅ desktop-таблицы/формы сохранены |

Продуктовая приёмка — только после ручного прогона на реальном iPhone.
