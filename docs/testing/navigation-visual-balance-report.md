# Навигация + multi-account + визуальный баланс — итоговый отчёт (§35)

Дата: 2026-07-28 · Ветка: main.

> **Честно (§35):** этап нельзя считать завершённым только по зелёным тестам. Доставлены:
> multi-account (полный backend + login + actions + UI, 18/18 тестов), навигационный редизайн
> (сгруппированный drawer + role-aware bottom nav + иконки + account switcher, 14/14). **Не
> доставлены полностью:** desktop sidebar expanded/compact/hidden, density-система и per-page
> визуальный баланс (analytics/OFD/collections/budgets/history/остальные), scroll-hide bottom nav,
> Playwright-скриншоты, unsaved-form guard. Это долг ниже + WAVE-продолжение. Продуктовая приёмка —
> только после ручного прогона на реальном iPhone/desktop.

Автотесты: `pilot:multi-account-sessions` 18/18 · `pilot:navigation-visual-balance` 14/14 ·
`pilot:full` (см. п.25).

## 28-точечный отчёт

1. **Раньше одна session.** Cookie `club_ops_session` → одна `Session` (HMAC tokenHash); резолв в
   `getValidSession`; scope в отдельных cookies.
2. **Почему не localStorage для токенов.** Токен контейнера — только в httpOnly cookie (JS не
   читает); пароли/чужие токены/список аккаунтов в localStorage/IndexedDB не хранятся.
3. **Модели.** `AccountSessionContainer` + `StoredAccountSession` (аддитивно, scalar-id, без FK;
   `User`/`Session` не тронуты).
4. **Как работает контейнер.** httpOnly cookie `club_ops_accounts` (HMAC) → контейнер →
   `activeStoredSessionId` выбирает активный `Session` по id.
5. **Как добавляется аккаунт.** Snapshot текущего → intent → `/login?mode=add-account` → OTP-login →
   attach + активен; остальные не отзываются.
6. **Как switch.** ownership + validity → `activeStoredSessionId`; scope-cookies очищены; revalidate
   layout + полный reload.
7. **Истёкшая session.** активная истекла → null → вход; статус «Требуется вход»; re-login обновляет
   только этот аккаунт.
8. **Удалить один.** revoke stored + его Session; репойнт активного; остальные целы.
9. **Выйти из всех.** revoke контейнер + все stored + их Session + legacy cookie.
10. **Утечка кеша.** scope-cookies очищаются при смене; финансовые страницы `force-dynamic` (не
    кешируются SW); полный reload после switch; container изолирован по id (MA12).
11. **PWA.** container-cookie 30d переживает перезапуск standalone → активен последний аккаунт;
    add-account идёт обычным login внутри standalone. (Ручная проверка — чек-лист.)
12. **Drawer.** сгруппирован по NAV_SECTIONS (Финансы/Планирование/Администрирование), группы
    сворачиваемые+запоминаются, иконки, current-account сверху, ≥44px — не плоская копия sidebar.
13. **Company/club context.** отделён от account switcher (ScopeSwitcher ниже блока аккаунта);
    account switcher меняет User, context — компанию/клуб внутри аккаунта.
14. **Desktop sidebar.** без изменений (existing accordion `NAV_SECTIONS`, `w-64`). **Режимы
    expanded/compact/hidden — НЕ реализованы** (долг).
15. **Bottom nav по роли.** `bottomNavOrder(roles)` — свой порядок для owner/GD/RD/manager/
    accountant/marketer, из существующих маршрутов (нет «Задачи» → landing/dashboard, §15).
16. **Когда bottom nav скрывается.** **scroll-hide НЕ реализован** (долг §16); сейчас статична;
    конфликт со StickyActions на формах остаётся (долг).
17. **Density tokens.** **НЕ введены** (долг §17) — планируются как CompactCard/MetricCard/
    SectionHeader/MobileDataCard/MobileFilterSummary/EmptyState.
18-22. **Analytics / OFD / Collections / Budgets / History.** визуальный баланс (таблицы→карточки,
    фильтры→sheet, компактные метрики, single-accordion) **НЕ выполнен** в этом этапе (долг);
    приоритеты и evidence — в [аудите](../audits/navigation-multi-account-visual-balance-audit.md).
23. **Light/dark.** новые компоненты (switcher, drawer группы) используют существующие
    theme-aware классы (slate/brand + `.dark` remap WAVE 1); попиксельно — на устройстве.
24. **320–1440.** drawer/switcher/bottom-nav — одна колонка, без общего h-scroll (WAVE-1 clip);
    попиксельная проверка визуальных страниц — после density-паса + на устройстве.
25. **Тесты/build.** `pilot:multi-account-sessions` 18/18; `pilot:navigation-visual-balance` 14/14;
    `pilot:full` (см. запуск гейтов); `tsc` чисто; `next build` + `build:prod` — успех; prisma
    validate dev+prod — valid.
26. **Commit hashes.** `18e742c` audit · `b89f1b3` migration · `a7b62df` service+tests ·
    `ef2f5af` login+actions · `1474af5` switcher UI · `5894826` nav redesign (+docs).
27. **Осталось на реальном iPhone.** весь [чек-лист](iphone-navigation-multi-account-checklist.md):
    add→switch→close→reopen, PWA persistence, bfcache/back, offline/expiry, safe-area, dark/light.
28. **Остаточные UX-проблемы / долг (WAVE-продолжение).**
    - Desktop sidebar expanded/compact/hidden (§14).
    - Density-система + per-page баланс analytics/OFD/collections/budgets/history/employees/sales/
      mandatory-payments/payments/dashboard/payroll (§17-25) — таблицы→карточки, фильтры→sheet.
    - Bottom-nav scroll-hide + скрытие при StickyActions/drawer/sheet (§16).
    - Unsaved-form warning + block-switch-during-upload (§9).
    - Playwright visual-скриншоты 320–1440 light/dark (§31).
    - Desktop dropdown-вариант switcher (сейчас единый Sheet).

## Критерии завершения (§35) — статус

| Критерий | Статус |
|---|---|
| Добавить второй независимый аккаунт | ✅ |
| Текущая session не завершается при add | ✅ |
| Безопасное переключение | ✅ |
| Корректная независимая история | ✅ (audit per-account) |
| Кеши/tenant не пересекаются | ✅ (scope-clear + reload + force-dynamic) |
| Удалить один / выйти из всех | ✅ |
| Drawer сгруппирован и компактен | ✅ |
| Sidebar expanded/compact/hidden | ❌ долг |
| Bottom nav role-aware + скрывается | ⚠️ role-aware ✅, scroll-hide ❌ долг |
| Analytics/OFD/Budgets/History без обрезанных таблиц | ❌ долг (density-пас) |
| Единая визуальная плотность | ⚠️ частично (WAVE-2 карточки эталон; остальное — долг) |
| Нет общего horizontal scroll 320px | ✅ (WAVE-1 clip) |
| Desktop не ухудшился | ✅ |
