# Mobile / PWA roadmap — дедлайн 18 августа 2026

Полная мобильная адаптация CLUB-OPS — обязательная часть приёмки к **18.08.2026**. Ниже —
критичные модули, порядок, сроки, критерии приёмки, устройства, PWA и риски. Payroll и
advances уже адаптированы (см. `mobile-readiness-audit.md`).

## Порядок и сроки

| # | Модуль | Срок | Объём |
|---|---|---|---|
| 0 | Payroll + Advances | ✅ сделано | 5 карточек, транши, формы, touch, numeric |
| 1 | Invoices | до 30.07 | список/позиции → карточки; загрузка файла full-screen |
| 2 | Expenses | до 03.08 | таблицы → карточки; модалки → sheet; фильтры-скролл |
| 3 | Refunds | до 06.08 | таблица + загрузка документов; действия в футере |
| 4 | Analytics / ОФД | до 09.08 | графики/таблицы → адаптив; горизонтальный скролл только внутри контейнера |
| 5 | Dashboard | до 11.08 | плотность карточек на 320; чипы провайдеров |
| 6 | Collections / Payments / Employees | до 14.08 | формы вертикально; карточки списков |
| 7 | Settings / OFD | до 16.08 | узкие формы шагов; sheet для диалогов |
| 8 | Регрессия + реальные устройства | 16–18.08 | сквозной прогон по ролям |

## Критерии приёмки (каждый модуль)
- 0 горизонтального скролла страницы на 320px (скролл только внутри `overflow-x-auto` блоков).
- Таблицы >5 колонок имеют карточный вид на `md:hidden`.
- Все основные действия доступны, touch ≥44px, не теряются под клавиатурой.
- Числовые/денежные поля открывают цифровую клавиатуру.
- Модалки → full-screen sheet на узких экранах.
- Деструктивные действия отделены и требуют подтверждения.
- `env(safe-area-inset-*)` для sticky/footer.

## Устройства для теста
- iPhone SE (375), iPhone 12/13 mini (360), iPhone 14/15 (390), iPhone Pro Max (430).
- Android: Pixel 5 (393), небольшой Android (360), планшет (768).
- Реальные устройства + Chrome/Safari devtools responsive.

## PWA (проверить, не обязательно завершать в этом этапе)
- `manifest` (name/short_name/start_url/display=standalone/theme-color/background), icons
  (192/512/maskable), `viewport` с `viewport-fit=cover`.
- Авторизация в standalone (куки/сессия), загрузка фото/файлов (refunds/invoices).
- Поведение при потере сети + экран недоступности сервера.
- Отсутствие критичной зависимости от hover; корректный back-navigation.
- CSS `env(safe-area-inset-*)`.

**План PWA:** Android-прототип (installable PWA) к 12.08; iOS/PWA ограничения (push,
файловый доступ, standalone-куки) задокументировать к 14.08; финальная проверка 16–18.08.

## Риски
- Широкие финансовые таблицы (invoices/expenses/refunds/analytics) — самый большой объём.
- iOS/Safari standalone: сессии-куки и загрузка файлов — проверить рано.
- Клавиатура iOS перекрывает поля/фидбек — sticky action bar + scroll-into-view.
- Плотность данных на 320px — приоритет карточкам и «краткому виду» по умолчанию.

## Статус — WAVE 1 доставлена (2026-07-28)

Системный фундамент готов и закреплён автотестами (`pilot:mobile-pwa-readiness` 31/31):

- **Foundation CSS/viewport:** `viewport-fit=cover`, зум-доступность сохранена, mobile inputs
  ≥16px (нет авто-зума), глобальный `overflow-x:clip`, safe-area утилиты, `break-anywhere`.
- **App-shell:** `MobileShell` — sticky top bar + drawer (полная role-навигация) + нижняя
  навигация (≤5 + «Ещё»); desktop sidebar/header под `lg:`, не тронут.
- **PWA:** `manifest.ts` (standalone, shortcuts), иконки 192/512/maskable, apple-мета,
  service worker (безопасный кеш — [pwa-cache-policy.md](../architecture/pwa-cache-policy.md)),
  `/install` + `/offline`, контролируемое обновление.

### Осталось до 18.08 (WAVE 2–5)

- **WAVE 2 (core finance):** карточная переверстка Расходы/Счета/Возвраты/Наличные на 320–430px.
- **WAVE 3 (operations):** payroll/advances довести до карточек + sticky action bar под клавиатуру.
- **WAVE 4 (analytics/admin):** широкие таблицы аналитики/ОФД → «краткий вид» + скролл-контейнеры.
- **WAVE 5 (perf + QA):** Lighthouse на мобильной сети; ручной прогон
  [iphone-pwa-manual-checklist.md](../testing/iphone-pwa-manual-checklist.md) на живых устройствах.

Полный статус приёмки — [mobile-pwa-report.md](../testing/mobile-pwa-report.md).

## Статус — WAVE 2 (финансовый контур) доставлена частично (2026-07-28)

Ядро мобильной адаптации расходов/счетов/возвратов + security-фикс перерасхода. Автотесты
`pilot:mobile-wave2-finance` 40/40. Аудит: [mobile-wave2-finance-audit.md](../audits/mobile-wave2-finance-audit.md).

**Сделано:** общий mobile-слой (`src/components/mobile/`: MobileListCard, Sheet, StickyActions,
FilterSheet, DocumentViewer, MobileFileField, StatusBadge); все 3 списка → карточки (desktop-
таблицы сохранены); role-логика перерасхода (реклама → только ГД, owner заблокирован, server-
guard + UI); sticky «Создать расход» и sticky nav wizard (keyboard-aware); встроенный doc-viewer
на расходах/счетах/возвратах; тап-таргеты ≥44px в критичных местах.

**Долг WAVE 3** (см. [mobile-wave2-finance-report.md](../testing/mobile-wave2-finance-report.md) п.21):
пагинация/lazy списков; видимый stepper wizard; sticky в calc-формах; повсеместный `StatusNote`;
расширенные фильтры; полная унификация upload; Playwright visual 320–1440; ручной прогон
[iphone-wave2-finance-checklist.md](../testing/iphone-wave2-finance-checklist.md) на устройстве.

## Статус — Навигация + Multi-account (частично, 2026-07-28)

Доставлено: multi-account (backend + login + switch/remove/logout-all + UI switcher; тесты 18/18),
навигационный редизайн (сгруппированный drawer + role-aware bottom nav + иконки; тесты 14/14).
Аудит: [navigation-multi-account-visual-balance-audit.md](../audits/navigation-multi-account-visual-balance-audit.md).
Модель: [multi-account-session-model.md](../architecture/multi-account-session-model.md);
угрозы: [multi-account-threat-model.md](../security/multi-account-threat-model.md);
отчёт: [navigation-visual-balance-report.md](../testing/navigation-visual-balance-report.md).

**Долг (WAVE-продолжение):** desktop sidebar expanded/compact/hidden; density-система + per-page
баланс (analytics/OFD/collections/budgets/history/остальные); bottom-nav scroll-hide + скрытие при
StickyActions; unsaved-form guard; Playwright visual 320–1440; ручной прогон
[iphone-navigation-multi-account-checklist.md](../testing/iphone-navigation-multi-account-checklist.md).

## Статус — Density Pass Part 1 (2026-07-29)

5 разделов уплотнены + density-система + bottom-nav scroll-hide. Тесты
`pilot:mobile-visual-density-part1` 24/24. Отчёт:
[mobile-visual-density-part1-report.md](../testing/mobile-visual-density-part1-report.md).

**Сделано:** density-компоненты (`src/components/mobile/density.tsx`); bottom-nav hide-on-scroll +
suppress при StickyActions/Sheet/drawer (`mobile-chrome.ts`); OFD summary+breakdown cards; budgets
cards+segmented+InfoNote; action-history FilterSheet+cards; collections single-active accordion;
analytics compact header+KPI.

**Долг Part 2:** analytics breakdown-таблицы → cards; ОФД статьи → cards; collections истории →
cards + формы на StickyActions; Playwright visual 320–1440; Dashboard/Payments/Mandatory/Employees/
Payroll; ручной прогон [iphone-mobile-density-part1-checklist.md](../testing/iphone-mobile-density-part1-checklist.md).

## Статус — Final mobile visual polish (2026-07-29)

Убраны ВСЕ эмодзи (единый SVG icon-set `src/components/mobile/icons.tsx`); полностью удалено нижнее
мобильное меню + dead-code (navigation-server, mobile-chrome, bottom-nav config, .pb-bottom-nav);
drawer bounded (`w-[min(88vw,360px)]` + overflow-x-hidden + min-w-0); симметричный header (44/1fr/44);
company/club stack; глобальный box-sizing для input/select/date; employees → карточки. Тесты
`pilot:final-mobile-visual-polish` 10/10. Отчёт:
[final-mobile-visual-polish-report.md](../testing/final-mobile-visual-polish-report.md).

**Остаток:** единый Button-variants компонент; глубокая пиксельная переверстка expenses top-actions/
status-tabs/dashboard month-nav; замена текст-глифов ✓/⚠ в payroll/sales; Playwright 320–1440; ручной
прогон [iphone-final-mobile-visual-polish-checklist.md](../testing/iphone-final-mobile-visual-polish-checklist.md).

## Статус — Final visual polish Part 2 (2026-07-29)

Button system (`buttons.tsx`) + shared MonthNav; expenses top-actions/status-chips, invoices KPI,
collections/employees CTA, dashboard/OFD month-nav. Реальный Playwright-harness (config+spec+bbox+
contact-sheet) — **не запущен в среде** (нет сети/браузера/OTP), команды для локального прогона в
[iphone-manual-acceptance-part2.md](../testing/iphone-manual-acceptance-part2.md). Тесты
`pilot:final-mobile-visual-polish-part2` 12/12. Отчёт:
[final-mobile-visual-polish-part2-report.md](../testing/final-mobile-visual-polish-part2-report.md).
NB: скриншоты приёмки были со старой сборки — нужен rebuild.

**Остаток:** DateField wrapper; общий FilterStack/FilterActionRow (invoices/analytics/ofd/budgets/
history); Refunds/Payroll/Settings pixel-pass; запуск Playwright + ручной iPhone.
