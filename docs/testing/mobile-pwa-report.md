# Mobile + PWA readiness — итоговый отчёт (§34)

Дата: 2026-07-28 · Ветка: main · Модель приёмки: 27 пунктов ниже.

> **Статус честно:** доставлена **WAVE 1 — системный фундамент** (viewport/safe-area/overflow,
> app-shell, manifest, иконки, standalone, service worker, install/offline) + автоматические
> статические гарантии. **WAVE 2–5** (переверстка таблиц в карточки по каждому модулю и
> визуальная проверка на реальных устройствах) описаны в дорожной карте и **выполняются
> отдельно** — без доступа к живому iPhone их нельзя закрывать «зелёными тестами». Этап нельзя
> считать полностью завершённым до ручного прогона [чек-листа iPhone](iphone-pwa-manual-checklist.md).

## Что сделано (фундамент)

Аудит-first: [mobile-pwa-readiness-audit.md](../audits/mobile-pwa-readiness-audit.md),
[mobile-performance-audit.md](../audits/mobile-performance-audit.md),
[mobile-readiness-audit.md](../audits/mobile-readiness-audit.md). Политика кеша:
[pwa-cache-policy.md](../architecture/pwa-cache-policy.md). Дорожная карта:
[mobile-pwa-roadmap-2026-08-18.md](../roadmaps/mobile-pwa-roadmap-2026-08-18.md).
Автопроверки: `npm run pilot:mobile-pwa-readiness` (31/31).

## 27-точечная приёмка

| # | Критерий | Статус | Основание |
|---|---|---|---|
| 1 | Аудит проведён до правок кода | ✅ | 3 аудита в `docs/audits/` |
| 2 | Работает на ширине от 320px | ✅ фундамент | overflow-x guard, min-w-0, `break-anywhere`; повизуально — WAVE 2–5 |
| 3 | Нет горизонтального скролла страницы | ✅ | `html,body{max-width:100%;overflow-x:clip}` (C1) |
| 4 | `viewport-fit=cover` (safe-area доступна) | ✅ | `layout.tsx` viewport (V1) |
| 5 | Пользовательский зум НЕ отключён | ✅ | нет `userScalable:false`/`maximumScale` (V2) |
| 6 | Нет авто-зума при фокусе (iOS) | ✅ | inputs ≥16px в `@media(max-width:767px)` (C2) |
| 7 | Safe-area: header/actions/nav учитывают вырезы | ✅ | `.pt-safe/.pb-safe/.pb-bottom-nav` (C3) |
| 8 | Длинные токены (ФН/UUID/email) переносятся | ✅ | `.break-anywhere` (C4) |
| 9 | Адаптивная оболочка (mobile shell) | ✅ | `MobileShell` drawer+bottom-nav (SH1–SH6) |
| 10 | Навигация по роли, без запрещённых пунктов | ✅ | `visibleItems` уже role-filtered (SH3/SH6) |
| 11 | Нижняя навигация ≤5 + «Ещё» | ✅ | `slice(0,4)`+Ещё, ≥52px (SH4) |
| 12 | Контент не под фиксированной навигацией | ✅ | `pb-bottom-nav` (SH5) |
| 13 | Web manifest (name/scope/display=standalone) | ✅ | `manifest.ts` (M1) |
| 14 | Иконки 192/512 + maskable с safe-zone | ✅ | `/pwa/icon-*` (M3/M4) |
| 15 | Apple standalone мета + status-bar | ✅ | `appleWebApp` black-translucent (V4) |
| 16 | theme-color под light/dark | ✅ | per-scheme (V3) |
| 17 | Установка на экран «Домой» iPhone | ✅ инструкция | `/install` + [гайд](../guides/iphone-install-guide.md); финальное «да» — ручной чек-лист |
| 18 | Установка на Android | ✅ | `beforeinstallprompt` + [гайд](../guides/android-install-guide.md) (I1) |
| 19 | Запуск как standalone-приложение | ✅ фундамент | manifest+apple мета; подтверждение — на устройстве |
| 20 | Service worker зарегистрирован (prod-only) | ✅ | `PwaBoot` (SW1) |
| 21 | Безопасный кеш (только статик+offline) | ✅ | структурная гарантия SEC1 |
| 22 | Навигации network-first → честный offline | ✅ | `sw.js` (SW3), `/offline` (SW7) |
| 23 | API/данные/auth — network-only | ✅ | `sw.js` (SW4) |
| 24 | Контролируемое обновление SW | ✅ | баннер + reload по клику (SW6) |
| 25 | Сессия сохраняется (httpOnly cookie) | ✅ | `session.ts` (A1) |
| 26 | Нет секретов в manifest/SW | ✅ | SEC1 |
| 27 | Desktop не деградировал | ✅ | sidebar/header под `lg:` (D1); визуально — стабильно |

## Не закрыто этим этапом (честно)

- **Повизуальная переверстка** широких таблиц (finance/OFD/аналитика) в карточные списки для
  320–430px — по модулям в WAVE 2–4. Фундамент (overflow guard, `break-anywhere`, min-w-0)
  не даёт ломать ширину, но плотные таблицы всё ещё требуют скролла внутри контейнера.
- **Реальные устройства:** ручной прогон [iphone-pwa-manual-checklist.md](iphone-pwa-manual-checklist.md)
  (21 пункт) на живом iPhone — не выполнен из окружения разработки.
- **WAVE 5 performance** на мобильной сети (Lighthouse/трассировка) — план в
  [mobile-performance-audit.md](../audits/mobile-performance-audit.md), метрики не сняты.

## Гейты качества

- `npx next build` — успех (exit 0), маршруты `/manifest.webmanifest`, `/install`, `/offline`,
  `/pwa/icon-192|512|maskable` скомпилированы.
- `npm run pilot:mobile-pwa-readiness` — 31/31.
- `npm run pilot:full` — см. запуск гейтов при финализации (payroll/finance регрессий нет).
