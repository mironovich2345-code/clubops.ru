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
