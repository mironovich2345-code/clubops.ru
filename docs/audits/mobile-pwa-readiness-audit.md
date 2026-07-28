# Аудит: Mobile + PWA готовность CLUB-OPS

Аудит **до** системных правок (§1: не делать хаотичные локальные CSS-правки до аудита).
Next.js 15 App Router. Ниже — фактическое состояние (файлы/строки) и план по волнам (§31).

## Текущее состояние (факты)
- **Root layout** (`src/app/layout.tsx`): `viewport` экспортирует ТОЛЬКО `themeColor: "#0F172A"`
  — **нет `viewport-fit=cover`** → safe-area insets недоступны. `appleWebApp.capable: true` есть.
  Иконки — App Router `icon.tsx`/`apple-icon.tsx` (32/180). **Манифеста нет.** theme-color один
  (не per-scheme).
- **globals.css**: `html,body{height:100%}` — **нет `overflow-x` guard**. `.input` = `text-sm`
  (**14px → iOS auto-zoom при фокусе**). **`env(safe-area-inset-*)` не используется нигде.**
- **Shell** (`src/app/(app)/layout.tsx`, `components/Sidebar.tsx`): фикс. сайдбар 256px всегда
  виден, **нет гамбургера/drawer/нижней навигации**; header — горизонтальный flex (ScopeSwitcher
  + UserBadge + Theme + 2 кнопки) → **переполнение на узких**.
- **PWA инфраструктуры нет**: нет manifest, service worker, /install, beforeinstallprompt.
  `public/` пуст. CSP уже разрешает `worker-src 'self' blob:` и `manifest-src 'self'`.
- **Таблицы**: 51 файл с `<table>/overflow-x-auto/min-w-`; карточные fallback (`md:hidden`) есть
  только у 5 payroll-страниц. Финансы (invoices/expenses/refunds/analytics/users/settings-OFD) —
  table-only.
- **Auth (плюс)**: cookie `club_ops_session` — **httpOnly, sameSite lax, secure(prod)**, 30 дней;
  токен НЕ в localStorage → standalone-дружелюбно. Redirect на `/login` — в layout.
- **Тема**: light|dark|system, `.dark` + `data-theme` + inline anti-flash script.
- **Уже есть** `docs/audits/mobile-readiness-audit.md` + `docs/roadmaps/mobile-pwa-roadmap-2026-08-18.md`
  (payroll/advances адаптированы; финансы 🔴 в очереди; PWA-раздел помечен «проверить, не
  обязательно завершать в тот этап»). Этот этап — закрыть PWA-фундамент.

## 18 пунктов
1. **Горизонтальный scroll.** Возможен глобально (нет overflow-x guard) + широкие table-only
   страницы (invoices/expenses/refunds/analytics/users/OFD-settings).
2. **Неадаптированные таблицы.** Все, кроме 5 payroll-страниц (карточек нет).
3. **Выход за viewport.** Длинные ФН/UUID/email/суммы без переноса; header-flex; таблицы.
4. **Наложение фиксированных.** Сейчас fixed/sticky в shell нет → наложений мало; риск появится
   при добавлении нижней навигации без safe-area.
5. **Клавиатура закрывает кнопки.** Нет sticky-actions с safe-area → в длинных формах кнопки
   уходят под клавиатуру (нет нижнего padding).
6. **Header много места.** Desktop header 64px + весь desktop-набор на mobile.
7. **Zoom при фокусе.** Да — `.input` 14px (< 16px).
8. **Модалки не помещаются.** Нет мобильных sheet-паттернов (модалки центрированные).
9. **Перегруженная mobile-навигация.** Сайдбар 256px всегда виден; нет «Ещё»/bottom nav.
10. **Много данных.** Analytics/OFD/списки без пагинации карточек на mobile.
11. **Тяжёлые client components.** ThemeToggle/ScopeSwitcher — лёгкие; основной вес — таблицы.
12. **Лишние запросы.** ScopeSwitcher `router.refresh()` на смену scope (ожидаемо).
13. **Валидный manifest.** Нет.
14. **Standalone.** Нет (нет display=standalone без манифеста).
15. **Авторизация после Home Screen.** Cookie httpOnly/lax/secure сохраняется в standalone —
    сессия работает; login-redirect в layout корректен.
16. **Что нельзя кешировать.** Все authenticated/API/финансовые/ПДн/OFD/документы/auth — только
    network (см. `docs/architecture/pwa-cache-policy.md`).
17. **Online-only.** Все рабочие данные — online-only; offline показывает честное состояние.
18. **Непроходимые с телефона сценарии.** Сейчас: перегруженный сайдбар/скролл таблиц мешают, но
    ключевые формы (расход/счёт/возврат) работоспособны; PWA-установки нет.

## План по волнам (§31)
- **WAVE 1 (этот этап) — Foundation:** viewport-fit=cover; глобальный overflow-x guard;
  `.input` 16px на mobile (без user-scalable=no); safe-area утилиты; **web manifest** (App Router
  `manifest.ts`, standalone, per-scheme theme-color, иконки 192/512/maskable); apple-метаданные;
  **service worker** (безопасная политика: только статик-shell; network-only для данных; честный
  offline; versioned cache; update flow); standalone-детект; **/install** гайд; **мобильный
  app-shell** (гамбургер+drawer из сайдбара, нижняя role-aware навигация, mobile header с
  safe-area), не ломая desktop (`lg:`).
- **WAVE 2–4 — постранично (по существующему roadmap до 18.08):** таблицы→карточки (invoices/
  expenses/refunds/analytics/users/OFD), sticky-actions с safe-area, sheet-модалки, файлы,
  клавиатуры/inputmode. Требует визуального QA на устройствах.
- **WAVE 5 — реальные устройства:** iPhone/Android/standalone/offline/update (ручной чеклист).

## Безопасность (§27)
Секреты не попадают в manifest/SW; sensitive-ответы не кешируются; SW scope ограничен; cache
versioned; logout сбрасывает app-cache; CSP уже строгий (nonce), worker-src/manifest-src
разрешены; HTTPS (Caddy HSTS); cookie httpOnly/secure.

## Не в scope
Новые бизнес-модули; payroll не расширяется. Полная постраничная переработка WAVE 2–5 —
последовательными коммитами по roadmap (частично в этом этапе, остальное задокументировано).
