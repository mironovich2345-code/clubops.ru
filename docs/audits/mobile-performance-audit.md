# Аудит производительности (mobile) — CLUB-OPS

Ориентир — реальный рабочий сценарий на 4G, не только synthetic score (§15/§30).

## Базовая архитектура (плюсы)
- **Server Components по умолчанию** (App Router) — большинство страниц серверные; клиентские
  границы точечные (формы, ThemeToggle, ScopeSwitcher, интерактивные секции).
- `output: "standalone"`, `reactStrictMode`, `poweredByHeader:false`.
- Шрифты — **системный стек** (нет загрузки web-fonts → нет font-блокировки, §9 «не отдавать
  пользователю файлы шрифтов» выполнено).
- Auth — httpOnly cookie, без клиентского токен-хранилища.

## Узкие места (по маршрутам)
| Маршрут | Основной вес | Оптимизация |
|---------|--------------|-------------|
| `/login` | лёгкий (форма) | ок; input 16px |
| `/dashboard` | server + OFD overview таблица | карточки на mobile (WAVE 3) |
| `/expenses`,`/invoices`,`/refunds` | серверные списки-таблицы | карточки на mobile + пагинация (WAVE 2) |
| `/analytics`,`/analytics/ofd-sales` | широкие таблицы (13/6 колонок) | карточки/скролл-контейнер + lazy (WAVE 4) |
| `/collections`,`/payments` | таблицы | карточки (WAVE 3) |
| `/payroll*` | серверные; карточки уже есть | ок (STAGE payroll) |
| `/settings/integrations/ofd` | таблица касс → **уже карточки** (этот проект) | ок |

## Что оптимизировано в этом этапе (WAVE 1)
- **Service worker**: кеширует ТОЛЬКО статические `_next/static` ассеты + иконки + manifest +
  app-shell offline-фолбэк → быстрый повторный старт без риска устаревших финансовых данных.
- **Нет web-fonts**, нет тяжёлых клиентских библиотек в shell.
- **Глобальный overflow-x guard** убирает layout-трэшинг от переполнения.
- Иконки — генерируются App Router (`ImageResponse`), кешируются иммутабельно.

## Что остаётся (WAVE 2–5, по roadmap)
- Таблицы→карточки на mobile (снижает DOM/повторные reflow на узких).
- Пагинация/lazy длинных списков (invoices/expenses/analytics).
- `dynamic import` тяжёлых интерактивных блоков (PDF preview, графики) — где появятся.
- Skeletons/loading для критичных страниц.
- Реальные замеры first-load/route-transition на 4G/slow-4G (§30) — на устройствах.

## Политика кеша
См. `docs/architecture/pwa-cache-policy.md`: static-only cache; network-only для authenticated/
финансовых/OFD/документов/auth; честный offline; versioned cache; skipWaiting только по действию
пользователя (не во время заполнения формы).

## Замеры до/после (§30) — план
Зафиксировать bundle/route-JS/response payload/requests на `/login`,`/dashboard`,`/expenses`,
`/invoices`,`/refunds`,`/collections`,`/payroll`,`/employees`,`/analytics`,`/settings/ofd`
на реальном устройстве (WAVE 5). В dev база пуста → синтетические числа не репрезентативны.
