# Аудит: навигация + multi-account + визуальный баланс

Дата: 2026-07-28 · Ветка: main. Проведён по реальному коду (3 параллельных обхода: auth/session,
навигация, визуальные страницы). До завершения аудита layout/CSS и Session-модель не менялись (§1).

Скоуп этапа: (1) убрать визуальный дисбаланс mobile, (2) перестроить mobile+desktop меню,
(3) role-aware навигация, (4) несколько независимых аккаунтов на устройстве, (5) строгая tenant
isolation + независимая история, (6) **не расширять бизнес-функции**.

---

## ЧАСТЬ A — Навигация (16 вопросов §1)

Файлы: `src/components/Sidebar.tsx`, `src/app/(app)/_components/MobileShell.tsx`,
`src/lib/navigation.ts`, `src/app/(app)/layout.tsx`, `src/app/(app)/_components/ScopeSwitcher.tsx`,
`src/components/UserBadge.tsx`.

1. **Почему mobile drawer перегружен.** Drawer (`MobileShell.tsx:61-67`) — **плоская копия** всего
   role-filtered `items` (18 пунктов), без группировки, без иконок, каждый `px-3 py-2.5`. Desktop
   Sidebar при этом уже группирован (`NAV_SECTIONS` single-open accordion). Т.е. mobile — не копия
   sidebar, а его ещё более плоская версия: длинный список на весь экран.
2. **Дубли drawer ↔ bottom nav.** Bottom nav (первые 4 из `PRIMARY_ORDER` + «Ещё») дублирует
   пункты, уже присутствующие в drawer (expenses/invoices/refunds/collections). «Ещё» открывает
   тот же drawer. Дублирование primary-действий без пользы.
3. **Что реально важно каждой роли.** Из `ROLE_PAGE_ACCESS` (`auth.ts:56-76`): manager —
   dashboard/expenses/collections/invoices/refunds/analytics; regional — + согласования/аналитика
   по клубам; accountant — workspace/invoices/expenses/refunds/payments/mandatory/balances;
   owner/GD — сеть/аналитика/планирование (operational-пункты скрыты `STRATEGIC_HIDDEN_PAGES`).
   Bottom nav сейчас один и тот же порядок для всех.
4. **Где bottom nav бесполезна.** Для owner/GD первые 4 `PRIMARY_ORDER` (workspace/dashboard/
   expenses/invoices) частично скрыты/нерелевантны — стратегу нужнее сеть/аналитика/планирование.
   Фиксированный financial-first порядок не подходит стратегическим и бухгалтерским ролям.
5. **Конфликт со sticky actions.** Bottom nav `fixed bottom-0 z-30` (`MobileShell.tsx:74`) и
   WAVE-2 `StickyActions` (`fixed bottom-0 z-30`, `lg:hidden`) — **оба фиксированы снизу**,
   перекрываются на формах создания/визарде. Bottom nav должна скрываться при StickyActions.
6. **Чрезмерные отступы.** `PageHeader` всегда `mb-6` + `text-2xl` (`PageHeader.tsx`); на каждой
   странице ещё `mb-5/mb-6/mb-8` первый фильтр/KPI-блок. `Section`/`Block mb-8` в collections/
   sales/ofd-sales = 32px разрывы. Первый экран часто уходит на header+фильтры.
7. **Слишком большие карточки.** Паттерн `p-5` + `text-2xl/3xl` KPI: analytics `KpiCard text-3xl`
   (`analytics/page.tsx:515`), payments/sales/ofd-sales/collections `p-5 text-2xl`. Дашборд
   `ClubCard p-5 text-2xl` + вложенный `grid-cols-2`.
8. **Сжатые desktop-таблицы на mobile** (не карточки): mandatory-payments (10 кол,
   `mandatory-payments/page.tsx:116`), budgets requests (10 кол, `budgets/page.tsx:242`) + лимиты
   (5 кол, :191), collections recon/ops history (9 кол, `collections/page.tsx:153,203`), activity
   log (8 кол, `activity/page.tsx:177`), analytics/expenses (8-9 кол, :167), analytics/ofd-sales
   MoneyTable (6 кол) + OfdRevenueTable, sales (3 таблицы), employees per-position, analytics
   weekday/manager (6-7 кол). Invoices/refunds — **уже карточки** (WAVE 2, эталон плотности).
9. **Фильтры на весь первый экран.** Худший — `activity` (`grid ... lg:grid-cols-6`, 6 полей
   стеком на 320px, :115-166) — журнал уходит за экран. Затем analytics/expenses (4 select + 4
   карточки), budgets (форма + переключатель + лимит-форма), employees (add-card + фильтр).
10. **Нарушенная иерархия.** `PageHeader text-2xl` не ужимается; несколько крупных заголовков
    секций (`bg-slate-50 text-sm font-semibold`) стекаются; статус-бейджи без `max-w`/`truncate`
    на большинстве страниц (кроме `StatusBadge` из WAVE 2) конкурируют с суммой.
11. **Как хранится одна активная сессия.** Cookie `club_ops_session` (httpOnly/sameSite lax/
    secure(prod)/30d, `expires`) → `Session` row (`tokenHash @unique`, HMAC-SHA256(SESSION_SECRET));
    `getValidSession` (`session.ts:123-145`) — единственная точка резолва user из cookie. Scope
    (компания/клуб) — отдельные cookies `scope_company`/`scope_club` (`access.ts:135-136`), не в БД.
12. **Почему нельзя несколько cookies с одним именем.** Браузер адресует cookie по имени —
    два `club_ops_session` в одном origin невозможны (второй перезаписывает первый). Даже если
    именовать по-разному — каждая была бы полноценным auth-грантом без контейнера, без «активного»
    указателя, без атомарного remove/logout-all, без изоляции scope. Нужен **контейнер**, который
    ссылается на несколько `Session` и выбирает активную.
13. **Изменения для безопасного multi-account** (детально в Части B): 2 аддитивные таблицы
    (контейнер + stored-session), одна правка `getValidSession` (резолв активной stored-session),
    bookkeeping в createSession/signOut/revoke, server-actions add/switch/remove/logout-all.
14. **Какие клиентские кеши чистить при переключении.** Scope-cookies `scope_company`/`scope_club`
    (иначе компания аккаунта A утечёт в вид B) → очистить/переименовать на switch; `revalidatePath
    ("/", "layout")` (как `setActiveScope`); bfcache/back-forward (authenticated страницы уже
    `force-dynamic`, но нужен `Cache-Control: no-store` гарантированно); клиентские draft-стейты и
    object-URL превью финансовых форм (живут в памяти компонента — их снимает полный reload);
    localStorage `theme`/`clubops:nav:open` — не чувствительны, не трогаем.
15. **Multi-account в iPhone PWA.** Container-cookie httpOnly/30d переживает перезапуск standalone
    → при повторном открытии активен последний аккаунт. Add-account идёт обычным login-flow
    (password+OTP) внутри standalone. Switch = server-action + полный reload. Safe-area для
    drawer/sheet/bottom-nav уже есть (WAVE 1). Риск: Safari может держать bfcache — `no-store`
    обязателен.
16. **Риски утечки между аккаунтами.** (a) scope-cookies общие на браузер → компания/клуб A видны
    в B до первого resolve — чистить на switch; (b) bfcache/back → старый authenticated контент;
    (c) client draft/object-URL финансовых форм; (d) URL документов в history (доступ ре-проверяется
    сервером по api-роуту, IDOR закрыт, но кэш ответа — no-store); (e) подмена `storedSessionId` не
    из своего контейнера — ownership-проверка обязательна; (f) отозванная/истёкшая session или
    заблокированный user не должны активироваться — гарантирует существующий `isValid()`.

---

## ЧАСТЬ B — Целевая multi-account модель (архитектурный выбор)

Существующий `Session` уже делает «сложную» безопасность: opaque random token, HMAC-only хранение
(`tokenHash @unique`), soft-revoke (`revokedAt`), проверка активности user (`isValid()`). Прецедент
для новой session-like таблицы — `SettingsPinSession` (scalar `userId`, **без FK/relation**,
`tokenHash @unique`, `expiresAt`, `revokedAt`).

**Решение: два аддитивных scalar-id (без FK) стола, `User`/`Session` не трогаем.**

```
AccountSessionContainer   // один на браузер/устройство
  id, tokenHash @unique    // HMAC нового httpOnly cookie `club_ops_accounts`
  activeStoredSessionId?    // указатель на активную StoredAccountSession
  expiresAt, revokedAt?, createdAt, updatedAt, lastActiveAt?
  userAgentHash?, deviceLabel?

StoredAccountSession       // одна строка на «припаркованный» аккаунт
  id, containerId          // scalar
  userId                   // scalar
  sessionId                // ссылка на существующий Session.id
  displayOrder Int, addedAt, lastUsedAt, revokedAt?
  @@unique([containerId, userId])   // один аккаунт-user на контейнер
  @@index([containerId])
```

Браузер хранит **только** случайный токен контейнера в httpOnly cookie. Не хранить пароли, чужие
session-токены, список аккаунтов в localStorage/IndexedDB (§4).

**Единственная нагрузочная правка — `getValidSession` (`session.ts:123`):**
1. Если `club_ops_session` валиден — вернуть как есть (нулевая регрессия для одиночных аккаунтов).
2. Иначе прочитать container-cookie → `AccountSessionContainer` по `tokenHash` (не revoked, не
   истёк) → `activeStoredSessionId` → `StoredAccountSession` → её `Session` через **существующий
   `isValid()`** → вернуть {session,user}.
Downstream (`getCurrentUser`→`getCurrentAccessContext`→`requirePageAccess`, `recordAudit`, scope)
не меняется — chokepoint один.

**Bookkeeping:** `createSession` — при существующем контейнере вставить/обновить `StoredAccountSession`
и сделать активной; `signOut`/`revokeCurrentSession` — снять/soft-revoke соответствующую stored,
если активная — переставить `activeStoredSessionId` на следующую (или очистить cookie, если пусто).
Новые server-actions: `addAccountToContainer`, `switchActiveAccount(storedId)`,
`removeStoredAccount(storedId)`, `logoutAllAccounts` — каждая ownership-проверяется по container-cookie.

**Инварианты (§27):** raw-токены не хранить (HMAC как у Session); `isValid()` — единственный гейт
(отозванная/истёкшая session, заблокированный user → «нет user» автоматически, т.к. контейнер лишь
ссылается на `Session.id`); switch меняет identity → `revalidatePath("/","layout")` + чистка scope-
cookies; ownership `storedSessionId` обязателен (не доверять submit); add-account login не
привязывать к чужому контейнеру; audit-события без секретов.

**Это НЕ смена роли (§3):** `User.role` не меняется, свободного select роли нет, impersonation нет.
Переключается фактический активный User/Session; действия пишутся от имени выбранного аккаунта.

---

## ЧАСТЬ C — Визуальный баланс: постранично

Эталон плотности (WAVE 2): `MobileListCard` (`p-3`, `space-y-3`), `StatusBadge` (width-safe).
Приводим остальное к нему. **Бизнес-логику не трогаем — только density/tables/filters/hierarchy.**

| Страница | Главные проблемы (evidence) | План |
|---|---|---|
| **activity** (история) | фильтр `grid ... lg:grid-cols-6` 6 полей (:115), таблица 8 кол `whitespace-nowrap` (:177) | фильтры → `FilterSheet` + chips; лог → карточки; desktop-таблица `hidden lg:block` |
| **mandatory-payments** | таблица **10 кол** (:116) | карточки; форма компактнее |
| **budgets** | лимиты 5 кол (:191) + requests 10 кол (:242); форма+switch+лимит-форма на первом экране | лимиты/requests → карточки; фильтр компактный; Бюджеты/План-факт → segmented |
| **collections** | recon/ops history 9 кол (:153,203); `OooCard/IpCard p-5 text-2xl`; `Section mb-8` | history → карточки+lazy; single-open accordion; уменьшить p-5→p-4, mb-8→mb-5 |
| **analytics** (main) | 5 raw tables (:165,605-758); `KpiCard p-5 text-3xl`; KPI `grid-cols-2`; период-форма | metric-cards компактнее; таблицы→карточки; доп.фильтры в sheet |
| **analytics/expenses** | 2 таблицы 8-9 кол (:167); 4 карточки+4 select на первом экране | таблицы→карточки; фильтры→sheet |
| **analytics/ofd-sales** | MoneyTable «По клубам»/«По юрлицам» 6 кол + OfdRevenueTable; `SalesCard p-5`; `Block mb-8` | breakdown→вертикальные data-cards (сущность/итог/нал/безнал/возвраты/чеки) |
| **sales** | 3 raw tables (:101,181); `Card p-5 text-2xl`; `mb-8` | таблицы→карточки; ужать заголовки |
| **employees** | таблица per-position (:125) `whitespace-nowrap`; add-card+фильтр сверху | таблицы→карточки; компактный фильтр |
| **payments** (календарь) | KPI `grid-cols-2` (:258); `KpiCard p-5 text-2xl`; 3 фильтр-ряда | metric-cards компактнее; ужать header-ряды |
| **payroll** | KPI `grid-cols-2 ... lg:grid-cols-5` 10 плиток (:111) | плитки компактнее/скролл; без раздувания |
| **dashboard** | `ClubCard p-5 text-2xl` + вложенный `grid-cols-2`; 2 фильтр-ряда (strategic) | ужать карточки/отступы |
| **invoices/refunds** | уже карточки; очереди стекаются `mt-4/6` | минорно: единые gaps |

**Density-система (§17):** ввести единый набор utility/компонентов, сверив с текущими токенами
(не вслепую): `PageHeader` (компактнее на mobile), `CompactCard`, `MetricCard`, `SectionHeader`,
`MobileDataCard`, `MobileFilterSummary`, `EmptyState`. Не плодить 10 почти одинаковых.

---

## ЧАСТЬ D — Навигационный редизайн (план)

- **Иконки:** добавить `icon` в `NavItem`/`NAV_SECTIONS` — предпосылка для drawer/sidebar/bottom-nav.
- **Mobile drawer:** ввести `NAV_SECTIONS`-группировку (Главное/Финансы/Планирование/Команда/
  Система), сворачиваемые группы, запоминание, активный пункт без огромной плашки, ≥44px, иконки,
  профиль-блок снизу компактно, current-account block сверху.
- **Company/club context:** заменить два тяжёлых `<select>` компактным control («ПИТЕР СПОРТ / Все
  клубы») → sheet/popover; для одного клуба не показывать select. Не смешивать с account-switcher.
- **Desktop sidebar:** три режима expanded/compact(rail+tooltip)/hidden; состояние в UI-preference
  (localStorage допустим для визуального состояния, НЕ для auth).
- **Bottom nav:** role-aware конфиг (существующие маршруты; если «Задачи» нет — честный landing/
  dashboard, зафиксировать ограничение); scroll-hide с гистерезисом; скрытие при drawer/sheet/
  StickyActions; safe-area.
- **Account switcher:** desktop — dropdown (паттерн `ThemeToggle`); mobile — full-screen `Sheet`.
  Текущий + другие аккаунты (имя/роль/компания/статус active|требуется-вход) + Добавить/Управление/
  Безопасность/Удалить текущий/Выйти из всех. Только безопасный summary (§29), не данные аккаунтов.

---

## ЧАСТЬ E — Ограничения / вне скоупа (честно)

- Полноценной страницы «Задачи» нет → bottom-nav «Задачи» = существующий landing/dashboard роли
  (зафиксировано, §15).
- Пагинация/lazy добавляем только где есть безопасная серверная основа; новую data-architecture не
  вводим (§24).
- Desktop/mobile рассинхрон меню (`mandatory_payments`/`balances` есть на mobile, нет на desktop) —
  унифицировать общей группировкой.
- Бизнес-логику модулей (workflow, формулы, права) не меняем (§6/§25).

---

## ЧАСТЬ F — План коммитов (§33)

1 audit · 2 multi-account миграция · 3 container/session сервисы (+getValidSession) · 4 add-account
login · 5 switch/remove/logout-all · 6 multi-account security tests · 7 account switcher UI ·
8 mobile drawer redesign · 9 desktop sidebar modes · 10 role-aware bottom nav · 11 density/design-
system · 12 analytics/OFD balance · 13 collections/budgets/history balance · 14 остальные страницы ·
15 visual tests/docs.

## ЧАСТЬ G — Критерии завершения (§35, не только зелёные тесты)

Второй независимый аккаунт добавляется без завершения текущей сессии; безопасное переключение;
корректная независимая история; кеши/tenant не пересекаются; удаление одного/выход из всех; drawer
сгруппирован и компактен; sidebar expanded/compact/hidden; bottom-nav role-aware + scroll-hide;
Analytics/OFD/Budgets/History без обрезанных mobile-таблиц; единая плотность; нет общего h-scroll на
320px; desktop не ухудшился. Продуктовая приёмка — только после ручного прогона на реальном iPhone.
