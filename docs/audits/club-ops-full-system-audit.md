# CLUB-OPS — Полный системный аудит

**Дата:** 2026-07-20
**Ветка:** `fix/invoices-ai-fields-review` (база `main`)
**Характер работы:** только чтение. Код, Prisma-схема, миграции и БД не изменялись. Ни commit, ни push, ни merge не выполнялись.
**Метод:** ручное чтение ключевых файлов (schema, `auth`, `access`, `analytics`, `money`, cron) + 10 параллельных исследовательских под-агентов по модульным кластерам. Каждый вывод привязан к `файл:строка`.

**Легенда маркеров доказательности** (используется по всему отчёту):

- **[ФАКТ]** — подтверждено чтением кода.
- **[ВЫВОД]** — интерпретация/инференс на основе фактов.
- **[РИСК]** — потенциальная проблема (см. реестр рисков, разд. 12).
- **[?]** — неизвестная или неоднозначная бизнес-логика; код допускает несколько трактовок.

---

## 1. Executive summary

CLUB-OPS — это Next.js 15 (App Router) / TypeScript / Prisma приложение для управления сетью фитнес-клубов, организованное по строгой мультиарендной иерархии **Company → (LegalEntity, Club)** с ролевым доступом на уровне компании и клуба. Проект зрелый: ~60 моделей БД, ~40 страниц, 17 API-маршрутов, ~19 файлов server actions, ~130 файлов бизнес-логики в `src/lib`, 27 «pilot»-наборов проверок.

**Сильные стороны (подтверждены):**

- **[ФАКТ] Изоляция арендаторов надёжна.** Единый паттерн `getXForContext(ctx, id)` (invoices/expenses/refunds/sales/sales-reports/budgets/mandatory-payments/legal-entities) проверяет `companyId === selectedCompanyId`, `allowedClubIds.includes(clubId)` и «manager-own» ДО любой мутации. Scope берётся из cookie, но валидируется против доступных пользователю компаний/клубов — подмена невозможна (`access.ts:150,159-161`). Ни один агент не нашёл подтверждённого P0/P1 доступа к чужой компании.
- **[ФАКТ] Переходы статусов — compare-and-set.** Денежные переходы (оплата счёта/возврата, подтверждение передачи наличных, верификация расхода) используют `updateMany({where:{id, status}})`; повторная/устаревшая заявка меняет 0 строк → «уже изменено». Защита от двойной оплаты у счетов и возвратов адекватна.
- **[ФАКТ] Секреты защищены.** Taxcom-креды AES-256-GCM at rest (`ofd/crypto.ts`), в UI не возвращаются; ключи ИИ/бота только из env; логи ИИ/OFD/уведомлений редактированы (id/коды/счётчики, без PII/секретов/содержимого документов).
- **[ФАКТ] Уведомления не могут откатить основную операцию** — durable outbox + отдельный drain; enqueue после commit, обёрнут в try/catch.

**Ключевые слабые места (подтверждены):**

- **[РИСК P1] Разрыв между «проверено ИИ» и оплаченными данными счёта.** Флаг `aiDataReviewedAt` не сбрасывается при последующем редактировании полей; medium-confidence вообще не гейтится; сумма/контрагент/реквизиты изменяемы после согласования без переутверждения и без истории прежних значений.
- **[РИСК P1] Два параллельных «мира» по нескольким доменам** (расходы v1/v2, возвраты v1/v2, наличные System A/System B, выручка Sale/SalesReport vs ОФД) с расходящимися правилами — источник несогласованности и потенциального двойного учёта.
- **[РИСК P1] Отсутствие идемпотентности** у создания `Sale`, `CashCollection/Withdrawal/OtherIncome` (нет dedup-ключа) → двойной сабмит удваивает выручку/движение наличных.
- **[РИСК P1] Возвраты v2 финансово невидимы** (нет стадии оплаты; терминальный статус не входит ни в один финансовый фильтр); а v1-переход `transitionRefund` не проверяет `entryVersion` → v2-возврат можно провести и оплатить в обход v2-контроля.
- **[РИСК P1] Живой контур наличных `/collections` не проверяет закрытие месяца** (MonthClose).
- **[РИСК P1] Импорт планов молча обнуляет** незаполненные строки шаблона → массовая потеря планов.
- **[РИСК P1] Масштабирование дашборда**: «6×клубов» веерных запросов + поцикловый бюджет, без кэша, ×компании на стратегическом пути.

**Финансовая ясность:** CLUB-OPS — это **управленческий** контур, а не бухгалтерия (не подменяет 1С). Модель признания смешанная: расходы по `expenseDate`, оплаченные счета по `expensePeriod` (начисление), оплаченные возвраты по `paidAt` (касса), выручка из ОФД-агрегатов ИЛИ Sale/SalesReport. Эта смешанность и наличие двух «миров выручки» — главный риск управленческой корректности.

**Готовность к банковской интеграции / ОФД-сверке:** данных для сверки ОФД↔эквайринг пока нет (нет источника эквайринга, нет разбивки по способам оплаты глубже cash/electronic, нет RRN/терминала). Фундамент (per-receipt cash/electronic split, фискальные реквизиты) есть.

**Сводка рисков:** P0 — **0** подтверждённых; P1 — **14**; P2 — **21**; P3 — **6**.

---

## 2. Карта архитектуры

### 2.1 Стек [ФАКТ]

| Слой | Технология | Подтверждение |
|---|---|---|
| Frontend | Next.js 15 App Router, React Server Components, Tailwind | `src/app/**`, `globals.css` |
| Backend | Next.js server actions (`"use server"`) + API routes | `src/app/(app)/**/actions.ts`, `src/app/api/**` |
| ORM | Prisma 5.22 | `prisma/schema.prisma` |
| Dev-БД | SQLite (`provider = "sqlite"`) | `prisma/schema.prisma:5-10` |
| Prod-БД | PostgreSQL (отдельная схема + миграции) | `prisma/production/schema.prisma` |
| Авторизация | Собственная: DB-сессии (httpOnly cookie `club_ops_session`, HMAC tokenHash) + обязательный email-OTP | `session.ts`, `auth.ts`, `login-challenge.ts`, `otp.ts` |
| Хранение файлов | Абстракция storage: local (`uploads/<key>`) или S3; ключи серверно-рандомные | `storage/index.ts`, `local-provider.ts`, `s3-provider.ts` |
| Фоновые процессы | Cron OFD-импорт (защищён Bearer-секретом), drain уведомлений | `api/cron/ofd/daily/route.ts`, `api/internal/notifications/drain/route.ts` |
| Внешние API | Taxcom (ОФД), OpenAI/Yandex (ИИ распознавание), Telegram Bot API | `ofd/taxcom/*`, `ai/*`, `telegram/*` |
| Уведомления | Durable outbox (`NotificationOutbox`) + Telegram | `notifications/*`, `telegram/*` |
| Аудит | `AuditLog` + `recordAudit()` | `access.ts:646-666` |

### 2.2 Слои [ФАКТ]

- **Страницы** (`src/app/(app)/**/page.tsx`) — RSC; каждая защищена `requirePageAccess(page)` (подтверждено для всех 25 (app)-страниц).
- **Компоненты** (`_components/**`, `[id]/_components/**`) — клиентские формы через `useFormState`.
- **Server actions** (`**/actions.ts`) — точки мутации; выполняют role → scope → object-ownership → бизнес-правило → запись → аудит.
- **API routes** (`api/**/route.ts`) — файловые стримы (с проверкой доступа), cron, drain, health, шаблоны, webhook Telegram.
- **Services / бизнес-правила** (`src/lib/**`) — чистые функции (правила статусов, расчёты) + загрузчики с БД. Repositories как отдельного слоя нет — доступ к Prisma инкапсулирован в `lib`-функциях.
- **Проверки доступа** — централизованы в `auth.ts` (роли/капабилити/страницы) и `access.ts` (scope/контекст/аудит).
- **Тестовая инфраструктура** — `scripts/pilot-*.mjs` (node, без раннера), агрегатор `pilot-full.mjs`.

### 2.3 Модули (вход, ключевые файлы, модели, источник истины) [ФАКТ]

| Модуль | Вход | Ключевые файлы | Модели | Источник истины |
|---|---|---|---|---|
| Счета | `/invoices`, `/invoices/[id]` | `invoices/actions.ts`, `lib/invoices.ts`, `ai/invoice-analyzer.ts`, `invoice-storage.ts` | `Invoice`, `PendingInvoiceUpload` | `Invoice.status` |
| Расходы (v1/v2) | `/expenses`, `/expenses/simple`, `/expenses/cash` | `expenses/actions.ts`, `simplified-actions.ts`, `lib/expenses.ts`, `expense-simplified.ts` | `Expense`, `ExpenseDocument`, `ExpenseCategory` | `Expense.status` + `entryVersion` |
| Возвраты (v1/v2) | `/refunds`, `/refunds/new/**` | `refunds/actions.ts`, `refund-document-actions.ts`, `refund-workflow.ts`, `refund-membership.ts`, `refund-personal-training.ts` | `Refund`, `RefundDocument` | `Refund.status` + `entryVersion` |
| Наличные | `/collections`, (retired `/expenses/cash`) | `cash-balances.ts`, `cash-collections.ts`, `cash-wallets.ts`, `collections/actions.ts` | `CashCollection/Withdrawal/OtherIncome`, `BalanceSnapshot`, `CashWallet/Movement` | Derived (расчёт из строк) |
| ОФД/Taxcom | `/settings/integrations/ofd`, cron | `ofd/importer.ts`, `ofd/taxcom/*`, `ofd/revenue.ts`, `analytics/ofd-management.ts` | `OfdConnection`, `OfdCashRegisterMapping`, `OfdReceiptImport`, `OfdReceiptItem`, `OfdDailySalesSummary`, `OfdRevenueCategoryDailySummary`, `OfdSyncRun/Error` | ОФД-агрегаты (recompute из строк) |
| Планы/Бюджеты/Импорт | `/budgets`, `/mandatory-payments`, dashboard-импорт | `imports/plan-import.ts`, `imports/budget-import.ts`, `budgets.ts`, `sales-plans.ts` | `Budget`, `SalesPlan`, `MandatoryPaymentPlan`, `ImportBatch` | Уникальные ключи (upsert) |
| Dashboard/Analytics | `/dashboard`, `/analytics`, `/analytics/ofd-sales` | `dashboard-cards.ts`, `analytics.ts`, `analytics/ofd-management.ts`, `forecast.ts`, `balance.ts` | (агрегирует все выше) | Общие функции `loadAnalyticsData`/`buildAnalyticsReport` |
| Пользователи/доступ | `/users`, `/settings` | `users/actions.ts`, `access.ts`, `invite-service.ts` | `CompanyUserAccess`, `ClubUserAccess`, `Invite` | `CompanyUserAccess`/`ClubUserAccess` |
| Аудит/уведомления | `/activity` | `access.ts` (recordAudit), `activity.ts`, `notifications/*` | `AuditLog`, `NotificationOutbox`, `TelegramConnection` | `AuditLog` |

### 2.4 Централизация vs размазанность логики [ВЫВОД]

- **Хорошо централизовано:** роли/капабилити (`auth.ts`), scope и контекст (`access.ts`), правила переходов статусов (чистые таблицы `applyInvoiceAction`, `applyApprovalAction`, `expense-simplified`), утверждающий (approver) резолвится единожды (`hasActiveRegionalApproverForClub`).
- **[РИСК] Размазано/дублировано:** три параллельные функции месяца у счетов (`invoiceAnalyticsDate`/`getInvoiceReportingMonth`/`getInvoiceOperationalMonth`); два контура наличных (System A ledger vs System B derived); два движка расходов (v1/v2); два движка возвратов (v1/v2); два «мира выручки» (Sale/SalesReport vs ОФД). Одна и та же проверка «регионал этого клуба» реализована и через `effectiveRoles.includes` и через `userHasClubRole` (refunds).
- **[РИСК] UI прячет действие, но серверная защита есть (обратный, безопасный случай):** отключённые фичи (`/balances`, bulk-monthly, manual sales-reports) заблокированы и на сервере через `disabled-features.ts`/явные ранние return — это правильно.
- **[РИСК] Серверная защита есть, но UI её не отражает (тоже безопасно, но путает):** оплата счёта с low-confidence блокируется на сервере и кнопка скрыта — согласовано. Однако cancel-статусы у счёта в UI и в `applyInvoiceAction` расходятся (см. разд. 5).
- **[?] «Только скрытие кнопки»** без серверной проверки — целенаправленно не найдено ни одним агентом; напротив, все мутации проходят серверные гейты. Единственные «UI-only» зоны — косметические (например `/refunds/new` доступна регионалу, но `createRefundDraft` — manager-only, форма отклонит на сабмите).

---

## 3. Иерархия данных

### 3.1 Текстовая схема [ФАКТ]

```
Company (id, name, inn, kpp)
 ├── LegalEntity (companyId) — тип "ooo"|"ip", реквизиты; isActive
 │     └── ClubLegalEntity (clubId, legalEntityId, isPrimary, isActive)   [M:N связь]
 ├── Club (companyId, city, isActive/archivedAt)
 │     └── ClubLegalEntity → LegalEntity   (≤1 активная ООО + ≤1 активная ИП на клуб, инвариант в коде)
 ├── CompanyUserAccess (companyId, userId, role)   @@unique[companyId,userId,role]
 └── Club → ClubUserAccess (clubId, userId, role)  @@unique[clubId,userId,role]

User (глобальный, email @unique; role="owner" по умолчанию, systemRole?)
 ├── companyAccess: CompanyUserAccess[]
 ├── clubRoles: ClubUserAccess[]
 └── (UserClubAccess — legacy, НЕ используется для доступа)

Операции: companyId + clubId (+ иногда legalEntityId) + createdByUserId
```

### 3.2 Ответы на вопросы раздела 2 задания

1. **Компания → несколько юрлиц?** [ФАКТ] Да. `Company.legalEntities: LegalEntity[]` (`schema.prisma:31`).
2. **Одно юрлицо → несколько клубов?** [ФАКТ] Да, через `ClubLegalEntity` (M:N), `LegalEntity.clubs: ClubLegalEntity[]` (`schema.prisma:81`).
3. **Один клуб → несколько юрлиц?** [ФАКТ] Да, но по бизнес-правилу «≤1 активная ООО + ≤1 активная ИП на клуб» (`schema.prisma:264-270`; инвариант обеспечивается в транзакции, `legal-entities.ts:151-153`).
4. **Где связь операции с company/legalEntity/club?** [ФАКТ] На самих операционных моделях: `companyId` + `clubId` есть у Invoice/Expense/Refund/Sale/CashCollection и др.; `legalEntityId` — у Invoice, Expense, Sale, MandatoryPaymentPlan, BalanceSnapshot, CashWallet, SalesReportLine.
5. **Только companyId:** `AuditLog` (clubId опционально), `SalesPlan` (clubId nullable = company-wide), частично агрегаты.
6. **Только clubId (без прямого legalEntityId):** `Refund` (см. п.8), `SalesReport`, `Budget` (по клубу+категории+месяцу), `CashCollection/Withdrawal/OtherIncome` (юрлицо выводится из клуба).
7. **Привязаны к legalEntityId:** `Invoice.legalEntityId?`, `Expense.legalEntityId?`, `Sale`, `MandatoryPaymentPlan`, `BalanceSnapshot`, `CashWallet`, `SalesReportLine`, `OfdReceiptImport.legalEntityId?`, `OfdDailySalesSummary`/`OfdRevenueCategoryDailySummary`.
8. **[РИСК P2] Где связь с юрлицом отсутствует, хотя по смыслу нужна:** **`Refund` не имеет `legalEntityId`** (`schema.prisma:363-457`), в отличие от Invoice/Expense. Возврат нельзя атрибутировать юрлицу, сделавшему продажу — пробел для по-юрлицовой сверки.
9. **Пользователь — роли в нескольких компаниях/клубах?** [ФАКТ] Да; строка на каждую (company/club, user, role). `getUserCompanies` объединяет компании из company- и club-доступов (`access.ts:71`).
10. **Как определяется текущий scope?** [ФАКТ] `getCurrentAccessContext` → `getCurrentCompanyAndClub`: cookie `scope_company`/`scope_club`, но **валидируется** против доступных сущностей (`access.ts:138-168`).
11. **Может ли scope влиять только на UI, но не ограничивать БД?** [ФАКТ] Нет. `allowedClubIds`/`selectedCompanyId` применяются в каждом list-загрузчике и в `getXForContext`; аудит-фильтр тоже (`activity.ts:346-370`).
12. **Риск пересечения данных компаний/юрлиц/клубов?** [ВЫВОД] На уровне доступа — не найдено (изоляция надёжна). На уровне **финансовой атрибуции** — да, локальные пробелы: `Refund` без юрлица; `loadClubCashBalances` фильтрует по `clubId` без `companyId` (безопасно, т.к. clubId глобально уникален, но не паттерн-консистентно — `cash-collections.ts:38`); мульти-ИП клуб «молча» отбрасывает второй ИП в расчёте наличных.

---

## 4. Матрица ролей

### 4.1 Роли (все, что существуют в коде) [ФАКТ]

Семь тенант-ролей (`auth.ts:16-23`, `access.ts:20-28`): **owner, general_director, regional_director, manager, chief_accountant, accountant, marketer**. И GD, и chief_accountant существуют как первоклассные роли.

- **Club-level роли** (`access.ts:31`): `regional_director, manager, accountant`. Company-level — все семь.
- **Расширение:** `chief_accountant → accountant` (`EFFECTIVE_ROLE_EXPANSION`, `auth.ts:176`); `regional_director` имплицирует `manager` (`ROLE_IMPLICATIONS`, `access.ts:46-55`).
- **Стратегические (read-only):** owner, general_director — просматривают, но не мутируют операционные записи (`canMutateOperationalRecords` их исключает; `STRATEGIC_READONLY_ERROR`).
- **Два глобальных админ-концепта вне тенант-ролей:** `User.role==="superadmin"` (обходит изоляцию, но **[ВЫВОД] нигде в приложении не присваивается** — регистрация ставит `"owner"`; фактически спящий) и `User.systemRole==="system_admin"` (CLI-only).

### 4.2 Матрица (роль → область → UI? / сервер? / scope? / принадлежность объекта?) [ФАКТ]

Легенда: все страницы проверяются `requirePageAccess`; все list-загрузчики — по `companyId`+`allowedClubIds`; одиночные записи — через `getXForContext` (company+club+manager-own). «✔» = проверяется, «—» = роли нет доступа.

| Область / действие | Кто (сервер) | UI | Сервер | Scope | Object-ownership |
|---|---|---|---|---|---|
| Dashboard | owner, GD, regional, manager, marketer | ✔ | `requirePageAccess` | ✔ | — (агрегаты по scope) |
| Analytics | owner, GD, regional, manager, marketer | ✔ | ✔ | ✔ | — |
| ОФД-sales page | owner, GD, regional, accountant, chief | ✔ | ✔ | ✔ | — |
| Счёт: просмотр | owner, GD, regional, manager(own), accountant, chief | ✔ | ✔ | ✔ | `getInvoiceForContext` |
| Счёт: создать/отправить | regional, manager (`canCreateOperational`) | ✔ | ✔ | ✔ | club валидируется на create |
| Счёт: редакт. полей | автор в draft/needs_correction; accountant если paid; стратеги заблокированы | ✔ | ✔ | ✔ | loader + author-check |
| Счёт: проверка ИИ-данных | accountant, chief, **owner** (`canReviewInvoiceData`) | ✔ | ✔ | ✔ | loader |
| Счёт: согласование/отклонение/возврат | regional клуба если активный есть, иначе chief-fallback; автор не самосогласует; owner/GD — нет | ✔ | ✔ | ✔ | loader + live approver |
| Счёт: оплата | accountant/chief; low-confidence блок до проверки ИИ-данных | ✔ | ✔ | ✔ | loader + CAS |
| Расходы: создать/редакт/отмена | create regional+manager; edit — стратеги заблокированы; cancel manager=own, regional=any | ✔ | ✔ | ✔ | `getExpenseForContext` |
| Документы (inline) | любой с доступом к записи; explicit download — accountant/chief | ✔ | ✔ | ✔ | file-route по записи |
| Возвраты (v1/v2) | create regional+manager (v2 draft — manager-only); approve regional/chief-fallback; pay accountant/chief (v1); стратеги read-only | ✔ | ✔ | ✔ | `getRefundForContext` + club-role |
| Продажи / sales-reports | create regional+manager (ручной ввод отчётов отключён); confirm/reject accountant | ✔ | ✔ | ✔ | `getSaleForContext`/`getSalesReportForContext` |
| ОФД-конфиг + «Синхронизировать сейчас» | owner, GD (`requireOfdAdmin`) | ✔ | ✔ | ✔ | connection по `{id,companyId}` |
| Наличные/инкассация/изъятие | create regional+manager; review accountant/chief/owner/GD; cancel автор-или-reviewer | ✔ | ✔ | ✔ | `findFirst{id,companyId,clubId in}` |
| Контрольный остаток (opening) | manager/regional/owner/GD/accountant/chief (`canSetOpeningBalance`); legacy `/balances` writer отключён | ✔ | ✔ | ✔ | club-scoped |
| Планы продаж | GD (`canManageSalesPlans`); импорт owner/GD | ✔ | ✔ | ✔ | club валидируется |
| Бюджеты | set owner/GD; overrun-approve owner/regional любой, GD adv+salary; импорт owner/GD | ✔ | ✔ | ✔ | `getBudgetRequestForContext` + `getManageableClubIds` |
| Обязательные платежи | owner/GD (`canManageMandatoryPayments`) | ✔ | ✔ | ✔ | loader |
| Аудит/Activity | owner, GD, regional, accountant, chief (marketer — нет) | ✔ | ✔ | ✔ | `buildActivityWhere` |
| Настройки компании | owner-only структурно (`requireOwnerOf`) | ✔ | ✔ | ✔ | `allowedCompanyIds` + owner |
| Настройки клуба / юрлица | owner-only; legal-entity ids валидируются к компании | ✔ | ✔ | ✔ | `assertLegalEntityAvailableForClub` |
| Пользователи/приглашения | invite по `getInvitableRoles`; управление по `canManageClub/CompanyUsers`; `assertCanManageUser` | ✔ | ✔ | ✔ | cross-company запрещён |
| Интеграции (ОФД) | owner/GD | ✔ | ✔ | ✔ | company-scoped |

### 4.3 Обходы (проверено) [ФАКТ]/[ВЫВОД]

- **Прямой URL:** каждая (app)-страница вызывает `requirePageAccess`; single-record — `getXForContext` → чужой id даёт 404. Не найдено обхода.
- **Server action / API:** action-и вызывают те же гейты; файловые маршруты биндят storage-key к scoped-записи. Не найдено обхода чтения/записи чужой компании.
- **Подмена ID (invoiceId/expenseId/refundId/clubId/companyId/legalEntityId):** на существующих записях `companyId` для записи всегда выводится сервером; form-поля `clubId/legalEntityId/companyId` принимаются только на **create** и ревалидируются (`allowedClubIds` + `canAccessClub` + `club.companyId===selectedCompanyId`).

**Ситуации, которые задание просило найти явно:**

- «Доступ только на скрытии кнопки» — **не найдено** (все мутации серверно-гейтед).
- «Роль проверяется, scope — нет» — **не найдено** в основных путях; исключения-хардненинги: `importTaxcomSalesForPeriod` грузит connection по id без `companyId` (безопасно, т.к. все вызовы предвалидируют — P2 defense-in-depth), OFD `legalEntityId` не проверяется на принадлежность компании (owner/GD-only — P2).
- «Scope проверяется, принадлежность конкретного объекта — нет» — **не найдено**; loader’ы проверяют оба.
- «Пользователь передаёт чужой invoiceId/expenseId/…» — блокируется loader’ами.
- «Объект грузится глобально по id, права проверяются после чтения/изменения» — паттерн есть у OFD-импорта (id без company), но не user-reachable без предвалидации; в остальных модулях проверка ДО мутации.

**[РИСК P2] Исключение:** `expenses/actions.ts:337` берёт `originalFileStorageKey` из формы клиента (в отличие от счетов, где `PendingInvoiceUpload` — серверный single-use). Практическая эксплуатируемость низкая (ключи рандомные, не перечислимы), но паттерн слабее.

---

## 5. Аудит модулей

### 5.1 Счета [ФАКТ]

**Статусы** (`invoices.ts`): `draft, needs_review, needs_correction, approved_by_regional, approved_by_chief_accountant, approved_by_owner`(legacy), `paid, rejected, canceled`. **[РИСК P2]** массив `INVOICE_STATUSES` (`:83-92`) пропускает `needs_correction` и `approved_by_chief_accountant`, тогда как labels их содержат — латентный пробел для потребителей массива.

**Действия:** `send_to_review, approve, return_for_correction, reject, pay, cancel`. Таблица `applyInvoiceAction`; `availableInvoiceActions`; переход `transitionInvoice`.

**Жизненный цикл:** upload+analyze (`uploadAndAnalyzeInvoice` → `analyzeInvoiceDocument`, персист файла + single-use `PendingInvoiceUpload`) → create прямо в `needs_review` (`createAndSubmitInvoice`, идемпотентно по `clientSubmissionId`, в `$transaction`) → согласование (routing: активный regional иначе chief-fallback; автор может самосогласовать — явное исключение) → pay (accountant/chief; CAS на `{id,status}`; `paidAt=now`). Историческая оплата: `saveHistoricalInvoice` (accountant/chief, confidence="high").

**Таблица переходов (сокр.):**

| From | To | Действие | Роли | Проверки | Аудит |
|---|---|---|---|---|---|
| draft, needs_correction | needs_review | send_to_review | manager/regional, **автор** | scope, month-close, `invoiceSubmitBlockedReason` (контрагент+сумма>0+файл) | `invoice.sent_to_review` |
| needs_review | approved_by_regional | approve | regional (активный) | scope, month-close | `invoice.approved_by_regional` |
| needs_review | approved_by_chief_accountant | approve | chief (fallback) | scope | `invoice.approved_by_chief_accountant` |
| needs_review | needs_correction | return_for_correction | regional/chief | причина ≥5 | `invoice.returned_for_correction` |
| approved_* | paid | pay | accountant/chief | **low-conf pay guard**; CAS | `invoice.paid` |
| draft (и др. в `cancelInvoice`) | canceled | cancel | manager/regional/accountant | month-close | `invoice.canceled` |

**[РИСК P2] Две поверхности отмены расходятся:** `applyInvoiceAction.cancel` разрешает только `draft`, а отдельный `cancelInvoice` + UI — draft/needs_review/approved_by_regional/approved_by_owner/paid. `approved_by_chief_accountant` **отсутствует** в списках отмены → chief-согласованный счёт нельзя отменить (только reject/pay).

**Новая ИИ-логика:**

- **[ФАКТ]** guard: `pay` отклоняется при `isLowConfidence(confidence) && !aiDataReviewedAt` (`actions.ts:990`); UI зеркалит (`page.tsx` фильтрует `pay` при `payBlocked`). Согласовано.
- **[РИСК P1]** флаг проверки **не сбрасывается** при последующем редактировании (`updateInvoice`/`saveAndResubmitInvoice` пишут `parsed.data`, но не обнуляют `aiDataReviewedAt`). Сценарий: low-conf проверен → возврат на исправление → автор меняет сумму/счёт → resubmit → approve → **pay проходит** на устаревшем флаге.
- **[РИСК P1]** medium-confidence **не гейтится** вообще; а `finalize()` присваивает medium именно когда слабое ключевое/критическое поле.
- **[РИСК P1]** сумма/контрагент/реквизиты **изменяемы после согласования** (`reviewInvoiceData` допускает approved_*/paid), без переутверждения и без «отпечатка» согласованной суммы — риск перенаправления платежа.
- **[РИСК P1]** нет истории прежних значений реквизитов; `invoice.updated`/`invoice.ai_data_reviewed` не пишут before/after.
- **[ФАКТ]** повторный ИИ-анализ существующего счёта **невозможен** (нет пути; `replaceInvoiceFile` не перезапускает распознавание → confidence/rawExtractedJson устаревают).
- **[ФАКТ]** двойная оплата защищена CAS; идемпотентность перехода pay — да.
- **[ВЫВОД]** двойного учёта счёт↔расход **нет**: оплаченный счёт считается расходом напрямую из таблицы `Invoice` (`analytics.ts:268`), не материализуется в `Expense`. Долг (`APPROVED_UNPAID`) и spend (`paid`) не пересекаются.
- **[РИСК P2]** редактирование оплаченного счёта не ревалидирует `/analytics`,`/dashboard`,`/budgets` (только `/invoices`) → устаревшая аналитика.
- **[РИСК P2]** month-close при редактировании проверяется по **старой** дате счёта, не по новым `invoiceDate`/`expensePeriod`.
- **[ФАКТ] Owner получает право записи финансовых полей** через `canReviewInvoiceData` — расходится со «стратегической read-only» моделью (задокументировано как намеренное, но раскол в модели безопасности).

### 5.2 Расходы [ФАКТ]

Два движка на одной таблице `Expense`, различаются `entryVersion`:

- **v1 (legacy):** чеки/переводы/manual/payroll; `saveExpenseImpl`/`updateExpense`/`cancelExpense`. Статусы `confirmed, waiting_budget_approval, budget_rejected, canceled, import_reverted`. **Документы не обязательны**, считается сразу (`confirmed`).
- **v2 (simplified/cash):** только наличные, роутится на активную ИП клуба. Статусы `draft, submitted, pending_regional_budget_approval, pending_owner_budget_approval, pending_accountant_verification, needs_correction, verified, cancelled`. Полная машина статусов, ≥1 документ на submit и на verify, макс 3 файла (атомарный re-count в `$transaction`), optimistic-lock.

**В spend аналитики** попадают `Expense.status ∈ {confirmed, verified}` + оплаченные счета + оплаченные возвраты (`analytics.ts:263-271`).

**Документы (сервер):** v2 требует ≥1 файл на submit/verify (server), макс 3; после `pending_*`/`verified` — иммутабельны; v1 не требует документов вовсе.

**Месяц/закрытие:** месяц = `expenseDate`. v2 запрещает будущие/прошлые месяцы (`validateExpenseBusinessDate`) и проверяет month-close на всех действиях. **[РИСК P2]** v1 будущие даты разрешает; **[РИСК P1]** `updateExpense` (v1) проверяет month-close по **старой** дате и не валидирует новую → можно перенести подтверждённый расход в закрытый/будущий месяц. **[РИСК P1]** v1 `confirmed`-расход свободно мутируется без переутверждения/иммутабельности.

**Двойной учёт (данные-пути):** [ФАКТ] `Expense`-строки пишут только `saveExpenseImpl`, `createSimplifiedExpenseDraft`, payroll-upload. Счета и возвраты **не создают** `Expense`. Верификация v2 создаёт один идемпотентный `CashMovement` (System A) — это отдельный реестр (не двойной учёт в P&L). **[РИСК P1] Реальный остаточный риск — ручное дублирование между модулями:** одну и ту же операцию можно завести и как `Refund`, и как ручной `Expense` категории `refunds` (`expenses.ts:60`); аналогично счёт+ручной расход, зарплата payroll+ручной расход категории `salary`. Технической дедупликации нет.

**[?]** `pending_owner_budget_approval` практически недостижим (`submitExpense` ставит только PENDING_ACCOUNTANT/PENDING_REGIONAL), хотя `approveOwnerBudget` существует — мёртвая ветка утверждения владельцем.

### 5.3 Возвраты [ФАКТ]

Два движка на `Refund`, по `entryVersion`:

- **v1 (legacy, AI-assisted):** сумма вводится вручную; статусы (`approval.ts`) `draft→needs_review→approved_by_regional|approved_by_chief_accountant→paid|rejected`; `documentsJson`. **v1 имеет стадию оплаты** (`transitionRefund` ставит `paid`/`paidAt`).
- **v2 (slot-based, серверный расчёт):** статусы (`refund-workflow.ts`) `draft→pending_regional_review→accounting_in_progress|needs_correction`(+soft `canceled`); `RefundDocument`. **[РИСК P1] v2 не имеет стадии оплаты** — UI прямо пишет «Оплата будет реализована на следующем этапе». `/refunds/new` ведёт только в v2.

**Расчёты (проверены):**

- **Абонемент** (`computeMembershipRefund`): дата-only через UTC day-index (без DST); `R = ceil(X·P/(T·100))·100`, округление вверх до рубля. Границы: `T≤0`→ошибка; `application>end`→блок; `serviceNotProvided` ИЛИ `application<start`→полный возврат; `application==end`→возврат 0. Никогда не отрицательный. Плановая дата = application+10 дней (Сб→пт, Вс→пн; праздники не учитываются).
- **ПТ** (`computePersonalTrainingRefund`): `serviceNotProvided` форсит E=0; `contract_rate: raw=X−V·E` (может быть отрицательным → `unavailable`, отказной черновик); `average_rate: R=ceil(X·(N−E)/(N·100))·100`. Хранимая сумма никогда не отрицательна (`amountKopeks = unavailable ? 0 : result`); `ptRawResultKopeks` хранит знак. Снапшот тренера переживает увольнение/переименование; **уволенный тренер выбираем** (намеренно).

**[РИСК P1]** после `needs_correction` операнды можно менять через «Сохранить черновик» (`saveMembershipInputs`/`savePersonalTrainingInputs`) **без пересчёта** `refundResultAmountKopeks`; `refundSubmissionReadiness` проверяет лишь наличие версии и result>0, но не консистентность вход/результат → можно переотправить устаревший расчёт.

**Документы:** фиксированный набор из 4 слотов на тип; без документов submit/расчёт заблокированы (сервер); файлы заменяемы (soft-remove `replaced`, `activeSlotKey @unique`); магия-байты vs MIME.

**Клиент «без клиента»:** `clientName/clientPhone` nullable; **v2 не собирает `clientName`** → список показывает `clientName || bankRecipientName || "— без клиента —"` (`refunds/page.tsx:98`).

**Финансы:** [ФАКТ] оплаченный **v1** возврат считается расходом (`analytics.ts:269`, категория `refunds`), уменьшает бюджет-used и прибыль; **не** трогает кассовые кошельки/балансы. **[РИСК P1]** v2-возвраты финансово невидимы (терминальный `accounting_in_progress` не входит ни в `paid`, ни в `APPROVED_UNPAID`). **[РИСК P1]** `transitionRefund` (v1) **не проверяет `entryVersion`** → v2-draft (status `draft`) можно провести через v1-трек и оплатить в обход v2-контроля.

**[РИСК P2]** нет `legalEntityId` у Refund. **[РИСК P2]** v2-действия не проверяют month-close.

### 5.4 Наличные и передача денег [ФАКТ]

**Два параллельных суб-контура:**

- **System B (живой) — «Фактический остаток».** Источник истины — **вычисляемый** (не хранимый): `calculateCashBalances` от контрольной точки `BalanceSnapshot` + ОФД-наличные + collections/withdrawals/ИП-расходы/«Иное». **Pending уже двигает баланс.**
  ```
  ООО = openingООО + ОФДcashООО(после чекпоинта) − инкассации − изъятияООО→ИП
  ИП  = openingИП  + ОФДcashИП + изъятияООО→ИП + «Иное» − ИП-расходы
  ```
- **System A (retired из UI, но всё ещё пишется) — CashWallet/CashMovement ledger.** `walletBalanceKopeks = Σ confirmed toWallet − Σ fromWallet`. `/expenses/cash` нейтрализована (её комментарий: показывала «второй, конфликтующий ИП-баланс»). **Но** `recordExpenseMovement` (`simplified-actions.ts:293`) продолжает писать этот ledger — живой write-путь без читателя.

**Ответы Q1–Q13 (сжато):** Q1 источник истины — derived. Q2 opening — append-only `BalanceSnapshot`, последний выигрывает. Q3 нет edit/hard-delete; отмена — soft, только draft/pending. Q4 двойное подтверждение защищено CAS; **[РИСК P1] создание НЕ идемпотентно** (нет dedup-ключа) → двойной сабмит удваивает движение. Q5 «Иное» **не** утекает в выручку/прибыль (читается только кассовыми либами). Q6 изъятие ООО→ИП корректно смоделировано как внутренний перевод (−ООО/+ИП, сумма сохраняется), не доход/расход. Q7 наличная выручка **не** дублируется (только из ОФД, ручного ввода в System B нет). Q8 юрлицо кассы = активная ООО/ИП клуба; ООО/ИП считаются раздельно; смешения между клубами нет. **[?]** мульти-ИП клуб молча отбрасывает второй ИП. Q9 отрицательный баланс допускается (без порогового алертинга в живом контуре; пороги −50k/−100k только в retired System A). **[РИСК P1] Q13/Q10 живой `/collections` НЕ проверяет month-close** (в `collections/actions.ts` — 0 упоминаний).

**«Иное»** — коллизия имён: `CashOtherIncome`/«Иное» (касса, не выручка) vs ОФД-категория `other`/«Иное» (это выручка). Разные данные, двойного учёта нет, но термин-ловушка.

### 5.5 ОФД и Taxcom [ФАКТ]

**Креды:** AES-256-GCM (`v1:base64(iv|tag|ciphertext)`), ключ из env `OFD_SECRET` (prod требует ≥32 симв., иначе throw; **[РИСК P2]** dev fallback — статичный ключ). В UI только флаги `hasLogin/hasPassword`. Аудит — только provider/authType/коды/счётчики.

**Роль/scope:** все OFD-действия через `requireOfdAdmin` (owner/GD) + `ofdEnabled()`. Cron `/api/cron/ofd/daily` — Bearer/`X-Cron-Secret`, fail-closed без секрета.

**Поток:** `importTaxcomSalesForPeriod` → concurrency-guard (`OfdSyncRun` pending/running) → decrypt → выбор маппингов **по scope (company+provider+active), не по connectionId** → (contract match) → per mapping×день: shifts→documentsByShift→normalize (только income/income_return) → dedupe → `createMany` только свежие → enrich items (DocumentInfo, FFD 1059) идемпотентно по `itemKey` → recompute daily + revenue-category summaries → финализация run.

**Идемпотентность:** `dedupeKey` (`taxcom:fn:fd:fpd` при наличии ФПД, иначе `taxcom:fn:fd`) `@unique`; `itemKey @unique`; агрегаты **пересчитываются из строк** (delete+recreate категорий) → повторный sync не удваивает. Чеки без позиций импортируются, позиции добираются позже (backfill). Возвратные чеки (`income_return`) неттятся. Коррекционные/сервисные — пропускаются. **Отменённые чеки — не обрабатываются (нет delete/void-пути).**

**Атрибуция:** клуб из маппинга ККТ; юрлицо `m.legalEntityId ?? connection.legalEntityId`; дата — `new Date(doc.dateTime)` (naive), бакет дня — UTC.

**[РИСК P1]** нестабильный `dedupeKey` при разном наличии ФПД между синками → один чек может вставиться дважды → удвоение выручки. **[РИСК P1]** выбор маппингов по scope (не по connectionId): две активные connection с общим/`null` юрлицом могут гонять ФН друг друга; при `null` юрлице фильтр снимается — тянутся все регистры компании. **[РИСК P1]** необёрнутое исключение на `createMany` оставляет `OfdSyncRun` в `running` навсегда → concurrency-guard блокирует все будущие синки. **[РИСК P2]** дата-выручки зависит от таймзоны сервера; **[РИСК P2]** нет обработки отменённых чеков.

**Готовность к «ОФД-сверке»:** есть per-receipt cash/electronic split, фискальные реквизиты (ФН/ФД/ФПД/смена/дата/операция), агрегаты по клубу/юрлицу/дню. **Нет:** источника эквайринга, разбивки способов оплаты глубже cash/electronic (нет RRN/auth-code/terminal/masked PAN/платёжной системы), даты сеттлмента, связи чек↔транзакция. Фундамент есть, но целевой таблицы для сверки нет.

### 5.6 Планы, бюджеты и импорт [ФАКТ]

Два импорт-пайплайна (планы, бюджеты), оба owner/GD-only, оба preview→confirm→apply. **MandatoryPaymentPlan импорта не имеет** (только ручной create). `ImportBatch`/file-hash dedup здесь **не** используется (только sales_reports/expenses/invoices).

- **Budget:** лимит расхода по категории/месяцу; `@@unique[clubId,category,month]`; upsert.
- **SalesPlan:** цель выручки; `@@unique[companyId,clubId,month,planType]`; пишет 3 строки (subs/pt/total=subs+pt).
- **[ФАКТ] Атомарность реальна:** apply в одном `$transaction`; невалидная строка отклоняет весь батч ДО записи; ошибка в транзакции откатывает всё.
- **[ФАКТ]** cross-company/архивные клубы заблокированы (preview scope + apply re-check `allowed`/`validClubIds`). Роли серверно проверены везде. Отрицательные — отклоняются. Ре-импорт идемпотентен (upsert).
- **[РИСК P1] Импорт планов молча обнуляет** пустые заполненные-шаблоном строки: пустая сумма → `{kopeks:0}`, применяется как update → **перезапись существующих планов нулём** (бюджеты этого избегают — skip пустых). Массовая потеря данных.
- **[РИСК P2]** нет revert/истории значений для плана/бюджет-импорта. **[РИСК P2]** нет month-close guard. **[ВЫВОД]** apply доверяет клиентскому `payload` (не ре-парсит файл), но валидирует границы (scope/категория/неотрицательное целое).
- **[?]** копейки: импорт округляет до рубля (`Math.round(rubles)*100`), ручной ввод сохраняет копейки (`rublesToKopeks`) — расхождение. Короткая запись «2,5» парсится как 2.5₽ (риск 1000×).

### 5.7 Dashboard и Analytics [ФАКТ]

**Dashboard** — сетка **карточек на каждый клуб** (`loadCompanyClubCards`, 1 раз на компанию, без N+1), с выбором месяца. Карточка: Выручка ОФД (если ofdHasData), Абонементы/ПТ (**значения из ОФД-категорий**, план из SalesPlan), Фактические расходы (фин.роли), Результат = ОФД-нетто − подтверждённые расходы, Наличные ООО/ИП (fact на `now`). Риск ООО/ИП вычисляется, но **не рендерится**.

**Gating:** `FINANCIAL_ROLES = owner, general_director, regional_director, accountant` → расходы/результат/прибыль. `canSeeCash` = доступ к collections (marketer исключён). `canSeeOfdSales` = owner/GD/regional. **[ВЫВОД] Прибыль скрыта от manager и marketer, НО регионал видит полную финансовую картину** (он в FINANCIAL_ROLES), в пределах своих клубов. Accountant/chief вовсе не имеют dashboard/analytics (workspace-based).

**Click-through:** карточка → `/analytics?clubId=…`; сервер honors `?clubId` только если `allowedClubIds.includes` (иначе fallback, без утечки).

**Consistency:** [ФАКТ] Dashboard и Analytics используют **одни и те же** ядро-функции (`loadAnalyticsData`+`buildAnalyticsReport`+`loadOfdManagementOverview`) — расходы/ОФД согласованы. **Расхождения:**

- **[РИСК P1] Три источника выручки не сверены.** `salesKopeks`/`profitKopeks` складывают `Sale` + `SalesReport.total_revenue`; ОФД — третий, независимый. Если у клуба есть и `Sale`, и `SalesReport` за ту же выручку — **двойной счёт** в `salesKopeks`/`profitKopeks`/`clubRanking`/`planPercent`. При `useOfd` отчётные тоталы скрыты в отображении, но подлежащие числа остаются удвояемыми.
- **[РИСК P1] Analytics: KPI Абонементы/ПТ берут значение из ОФД, а план-бар «факт» — из подтверждённых отчётов.** Для ОФД-only клубов (заявленная норма) KPI показывает ОФД-продажи, а план-бар — 0%. Dashboard-карточка это чинит (пересчёт `subsPct` из ОФД), Analytics — нет → экраны расходятся.
- **[ВЫВОД] Два мира выручки не связаны мостом:** ОФД-чеки **не** создают Sale/SalesReport. Основная P&L «выручка/прибыль» считается по Sale+SalesReport (ручной ввод отчётов отключён; `createSale` ещё жив, gated `canCreateOperational`), а реальная текущая выручка — в ОФД-агрегатах, показываемых отдельно. Это ключевой вопрос управленческой корректности (см. разд. 6 и разд. 13).

**Analytics-метрики:** периоды (неделя/месяц/год ± предыдущий, custom); фильтры strategic (company/city/club); Выручка ОФД (gross), Абонементы/ПТ, Фактические расходы, Результат (ОФД−расходы), Прибыль (Sale−spend), Долги (approved-unpaid), Прогноз/Риск (balance vs 30-дн обязательства), Наличные (fact totals). **[РИСК P2]** `budgetPerformance` считается только по `period.primaryMonth` (несогласованность для мульти-месячных периодов). **[?]** архивные клубы: явного исключения в анализируемых файлах не найдено — зависит от scope-резолверов (не верифицировано).

---

## 6. Финансовая и бухгалтерская модель

**[ВЫВОД] CLUB-OPS — управленческий учёт, а не бухгалтерия.** Он агрегирует факты/намерения/движения для управления сетью, не претендуя на роль 1С.

### 6.1 Таблица признания [ФАКТ]/[ВЫВОД]

| Сущность | Фин. смысл | Момент признания | Доход? | Расход? | Деньги? | Прибыль? | Источник истины | Риск двойного учёта |
|---|---|---|---|---|---|---|---|---|
| ОФД-чек (`OfdDailySalesSummary`/category) | Реальные продажи | Дата чека (начисление) | Да (income/net) | Нет | Да, наличная часть → fact-баланс | Да (ОФД-результат) | `loadOfdManagementOverview` | Параллельно Sale/SalesReport; overlay заменяет отображение, но подлежащий `salesKopeks` всё ещё считает |
| `Sale`/`SalesReport.total_revenue` (confirmed) | Ручная/legacy выручка | saleDate/reportDate (начисление) | Да | Нет | Нет | Да | `loadAnalyticsData` | Sale+report за один день → двойной счёт |
| Оплаченный счёт | Затрата поставщику | Гейт по оплате (`paid`), месяц = `expensePeriod` | Нет | **Да** | Отчёт оплаты по `paidAt` | Да | `Invoice status=paid` | Месяц начисления ≠ месяц оплаты |
| Approved-unpaid счёт/возврат | Обязательство/долг | При согласовании | Нет | Нет | Нет | Нет (как обязательства) | `APPROVED_UNPAID` | Не должен быть и в spend — обеспечено |
| Расход (Expense) | Операционная затрата | `confirmed`/`verified`, месяц=`expenseDate` | Нет | Да | ИП-нал расходы уменьшают ИП fact | Да | `Expense` realized | Ручной дубль с Refund/Invoice/payroll |
| Возврат клиенту (v1 paid) | Возврат денег | `paid`, месяц=`paidAt` | Нет | **Да** (категория refunds) | Не в fact-нал | Да (−прибыль) | `Refund paid` | Ручной дубль как Expense |
| Возврат v2 (accounting_in_progress) | Возврат (не оплачен) | — (нет стадии оплаты) | Нет | **Нет (невидим!)** | Нет | Нет | `Refund` v2 | Недоучёт расхода |
| ОФД-возврат (`returnTotalKopeks`) | Фискальная коррекция | Дата чека | Уменьшает нетто-выручку | Нет | Уменьшает наличные | Уменьшает ОФД-результат | ОФД-агрегаты | Отдельно от Refund |
| Инкассация (ООО→банк) | Внутренний перевод | pending/approved | Нет | Нет | Да (−ООО) | Нет | `CashCollection` | Корректно исключён из P&L |
| Изъятие (ООО→ИП) | Внутренний перевод | pending/approved | Нет | Нет | Да (−ООО/+ИП) | Нет | `CashWithdrawal` | Корректно исключён |
| «Иное» (`CashOtherIncome`) | Ручное пополнение ИП-нал | pending/approved | **Нет** | Нет | Да (+ИП) | **Нет** | `cashOtherIncome` | Коллизия имени с ОФД `other` (разные данные) |
| Эквайринг-комиссия | Комиссия банка | — | **Не смоделирована** | Только вручную | Нет | Нет | нет | Выручка показана gross |
| SalesPlan | Цель | n/a | Нет | Нет | Нет | Нет | `SalesPlan` | Проекция |
| Budget | Лимит расхода | n/a | Нет | Нет | Нет | Нет | `Budget` | Проекция |

### 6.2 Ответы на вопросы раздела 11

- **Начисление vs касса:** [ФАКТ] **смешано.** Счета — начисление (`expensePeriod`); расходы — по `expenseDate`; возвраты — касса (`paidAt`); ОФД — по дате чека. Это создаёт несогласованные базы внутри одного «spend»/«прибыль».
- **Когда счёт становится расходом:** только `status=paid`, в месяц `expensePeriod` (**[РИСК P2]** может ретро-менять «закрытый» месяц при поздней оплате).
- **Когда возврат становится расходом:** v1 — при `paid` (месяц `paidAt`); v2 — **никогда** (пробел).
- **ОФД — доход или только источник продаж?** [ВЫВОД] И то, и то: ОФД-нетто трактуется как выручка/результат в ОФД-overlay, но основная P&L-прибыль его не включает (считается по Sale/SalesReport).
- **Эквайринг-комиссия:** [РИСК P2] не моделируется против выручки → прибыль/результат завышены на комиссию, если не введён ручной расход.
- **Внутренние переводы/«Иное»:** корректно исключены из дохода/расхода/прибыли.
- **Смешение денег компании и регионала / разных юрлиц / упр. и бух. учёта:** [ВЫВОД] денег регионала как отдельного кошелька в живом контуре нет (изъятие ООО→ИП — внутри клуба); ООО/ИП считаются раздельно; управленческий и бухгалтерский смысл не смешиваются (это чисто управленческий контур).
- **Термины, которые бухгалтер поймёт иначе:** «Иное» (касса vs ОФД-категория), «возврат» (Refund vs ОФД `return`), «Результат» (ОФД−расходы) vs «Прибыль» (Sale−spend).
- **Двойной учёт одной операции:** возможен (см. риски P1: ручной дубль расхода; Sale+SalesReport; нестабильный ОФД dedupeKey; неидемпотентные Sale/наличные).

---

## 7. Целостность данных

**[ФАКТ] В целом система хорошо защищена.** Каждая по-настоящему многотабличная операция (приём инвайта, создание клуба, переназначение юрлица, удаление аккаунта, payroll, загрузка документов, подтверждение наличных, reopen месяца, импорты) обёрнута в `$transaction`; одиночные переходы статусов используют CAS `updateMany({where:{id,status}})`. Клуб↔юрлицо защищено row-lock + инвариантом.

**Идемпотентность/уникальность (schema):**

- **Есть dedup:** `Invoice.clientSubmissionId`, `OfdReceiptImport.dedupeKey`, `OfdReceiptItem.itemKey`, `OfdDailySalesSummary.summaryKey`, `OfdRevenueCategoryDailySummary.summaryKey`, `CashMovement @@unique[sourceType,sourceId]`, `CashNotification.dedupeKey`, `Budget @@unique[clubId,category,month]`, `SalesPlan @@unique[...]`, `PayrollStatementRow @@unique[...rowHash]`, `MonthClose @@unique[...]`.
- **[РИСК P1] НЕТ dedup:** **`Sale`**, **`CashCollection`/`CashWithdrawal`/`CashOtherIncome`**, `Expense` (только index), `Refund`. → двойной сабмит удваивает выручку/движение наличных.

**[РИСК P2] Аудит неатомарен и не защищён.** `recordAudit` — отдельный `create` ПОСЛЕ commit, нигде не обёрнут в try/catch. Следствия: (а) сбой аудита не откатывает деньги (хорошо), но (б) закоммиченный денежный переход + сбой вставки аудита → пользователь видит ошибку, деньги ушли, аудит-строки нет.

**[РИСК P2] ОФД-импорт идемпотентен, но не транзакционен** (чеки/позиции/агрегаты — раздельные автокоммиты; concurrency-guard неатомарен) → при краше — устаревшие агрегаты до ре-запуска; две гонки могут пройти guard.

**[РИСК P3] TOCTOU** в создании cash-перевода (баланс проверяется до транзакции), но `confirmInternalTransfer` перепроверяет внутри → овердрафт не реализуется.

---

## 8. Безопасность и изоляция scope

**[ФАКТ] Вывод: изоляция арендаторов надёжна. Подтверждённого P0/P1 cross-tenant чтения/записи не найдено.**

- Сессии: httpOnly cookie, HMAC tokenHash, revocation-aware, свежий DB-read каждый запрос. Логин — пароль + обязательный email-OTP (HMAC, constant-time, лимиты); Session создаётся только после OTP.
- Scope из cookie **валидируется** против доступных компаний/клубов; подмена cookie/query → fallback на доступное. `setActiveScope` проверяет доступ перед записью cookie.
- `getXForContext` — единый паттерн проверки company+club+manager-own ДО мутации во всех модулях. Form-`clubId/companyId/legalEntityId` принимаются только на create и ревалидируются.
- Файловые маршруты биндят storage-key к scoped-записи; bulk-export отключён (404).
- OFD-креды зашифрованы, в клиент не отдаются; cron защищён секретом.
- User-management: `assertCanManageUser` scope-aware default-deny; last-owner protection; смена доступа атомарно ревокает сессии.

**Хардненинг-замечания (P2/P3):** expense `storageKey` из формы клиента (P2); OFD `legalEntityId` без company-проверки (P2, owner/GD-only); `importTaxcomSalesForPeriod` грузит connection без companyId (P2 defense-in-depth); `loadClubCashBalances`/бюджеты фильтруют по `clubId` без `companyId` (P3, корректно но не паттерн-консистентно); cron-секрет сравнивается `===` (P3, тайминг); `superadmin`-байпас спящий (не присваивается в приложении — верифицировать, что миграции/сиды его не пишут).

---

## 9. Аудит файлов и интеграций

### 9.1 Аудит действий [ФАКТ]

Модель `AuditLog`: `companyId?, clubId?, userId?, action, entityType, entityId?, metadataJson?, createdAt`. **Нет** выделенных колонок before/after, reason, IP, userAgent (только ad-hoc в `metadataJson`). **[ФАКТ]** аудит **иммутабелен в коде приложения** (0 update/delete путей вне тестовых фикстур), но **[РИСК P2]** нет БД-уровневой иммутабельности (нет append-only/hash-chain). **[РИСК P2]** нет IP/UA/структурного before-after → слабее для форензики; `invoice.updated` не пишет значения. Просмотр: owner/GD — вся компания; regional — allowedClubs; manager — allowedClubs ИЛИ свои; marketer — нет. **Manager видит аудит** (свои + по своим клубам). Метаданные безопасны (нет реквизитов/секретов/содержимого).

**Критичные действия — аудит есть:** `invoice.paid`, `cash.transfer_confirmed`, `ofd.*` (sync/creds), `user.access_changed`/`access.granted`/`access.removed`, `invitation.*`, `import.*`, `club.archived`. **[?]** `recordAudit` не гарантированно транзакционен с операцией.

### 9.2 Файлы и документы [ФАКТ]

- Хранение: local `<cwd>/uploads/<key>` (вне `public/`) или S3. Ключи **серверно-рандомные** (16/32-байт hex), не оригинальное имя.
- Path-traversal: `isSafeStorageKey` (`..`, `\`, ведущий `/`, длина, regex); per-reader ещё строже.
- Авторизация скачивания: каждый маршрут через `getXForContext` (чужой id → 404); refund/sales-report дополнительно проверяют, что key принадлежит записи. `safeDownloadHeaders` — Content-Type из allowlist расширения ключа, `attachment` для прочего, `nosniff`, `Cache-Control: private,no-store`.
- Валидация: declared MIME + размер + **магия-байты vs MIME** (HEIC отклонён); лимиты (10MB/файл, 40MB агрегат, 1–3 файла v2).
- `getSignedUrl` (S3 presign) **не используется** — всё через авторизованные маршруты.

**[РИСК P2]** expense-doc маршрут ставит Content-Type = `doc.mimeType` (хранимый), а не allowlist ключа — безопасно только за счёт upload-инварианта. **[РИСК P2]** нет очистки storage-объектов при удалении/архивации сущности → orphan-файлы (в т.ч. с финансовым содержимым) остаются. **[РИСК P2]** нет антивируса. **[РИСК P3]** upload читается целиком в память (cap 10MB).

### 9.3 Уведомления / Telegram [ФАКТ]

Durable outbox (`NotificationOutbox`: pending/sending/sent/skipped/failed, attempts, nextAttemptAt); enqueue = insert, доставка — отдельный drain (Bearer-секрет). Retry экспоненциальный (cap 30 мин, honors `retry_after`, max 5); claim через CAS pending→sending. Токен бота/секреты — только env; `chatId` в клиент не отдаётся; webhook — секрет-хедер; линковка self-service (нет админ-оверрайда).

**[ФАКТ] Сбой уведомления НЕ может откатить основную операцию:** enqueue после commit, обёрнут в try/catch (не бросает), реальная отправка — в drain. Сообщение ретраится, не теряется на транзиентном сбое. Данные в Telegram минимальны (заголовок, клуб, сумма-рубли, deep-link) — без реквизитов/PII/комментариев.

**Точка отказа (сетевая блокировка РФ):** отправка `sendTelegramMessage` (12с timeout, не бросает) — при блокировке вернёт типизированную ошибку → outbox ретраит до 5 раз, затем `failed`. Основная операция не ломается. **[РИСК P2]** `no_connection` → терминальный `skipped` (не переотправляется после поздней линковки); **[РИСК P2]** нет lease-timeout на `sending` (краш drain → строка навсегда в `sending`); **[РИСК P3]** токен в URL (инфра-логи).

### 9.4 ИИ-интеграция [ФАКТ]

Провайдеры: `yandex` (RU, prod), `openai` (dev/test), `mock` (default). Модели: OpenAI gpt-4o-mini→gpt-4o (fallback once), Yandex OCR `page` + `yandexgpt-5-lite`. PDF с текст-слоем — локально (без внешнего вызова); скан → рендер стр.1 в PNG → OCR. Timeout 60с; fallback один раз; расхождение моделей по критич.полю → `confidence:low`. Ключи из env; **логи редактированы** (только correlationId/stage/code/httpStatus/durationMs/confidence/missingFieldNames/fileSizeBucket — без base64/OCR-текста/промпта/реквизитов). Prompt-injection: системный промпт «текст документа — ДАННЫЕ, не инструкции» + разделители `"""`; строгая валидация выхода (только схема-ключи). Yandex `x-data-logging-enabled=false`; сырой ответ на Yandex-пути **не** сохраняется.

**Достаточность pay-guard (пробелы):** **[РИСК P1]** medium не гейтится; **[РИСК P1]** флаг проверки не сбрасывается при редактировании; **[РИСК P2]** warnings игнорируются гвардом (кроме тех, что форсят `low`); **[РИСК P2]** у возвратов guard’а нет; **[РИСК P2]** prod-мисконфиг `AI_PROVIDER=openai` молча отправит реальные финдокументы за пределы РФ (только env-гейт + один лог, не жёсткий prod-блок).

---

## 10. Тестовое покрытие [ФАКТ]

- **Нет стандартного раннера** (нет `test`-скрипта, нет vitest/jest). 4 файла `*.test.ts` содержат самодельный `assert()`, экспортируют `run*SmokeTest()`, **которые никто не вызывает** — мёртвый код.
- **Реальный набор** — 27 `scripts/pilot-*.mjs`, агрегатор `pilot-full.mjs` (spawnSync + regex-scrape хвоста; guard от prod-БД). ~2 260 `check()`-проверок. `readFileSync` встречается 187× (якорь статических «source-string» гвардов). 19/27 pilots используют реальную sqlite-БД; 8/27 — чисто/статик.
- **Поведенческое vs статическое ≈ 65–70% / 30–35%.** Поведенческое = зеркала чистых функций + реальные DB-проверки (cash ledger, ОФД идемпотентность «0 новых строк»). Статическое = `readFileSync + includes/regex` пиннинг shipped-кода к зеркалу.

**Покрытие по областям (реальное / string-guard / нет):**

- Роли/права — **реальное**. Scope/ID-spoof/cross-company — **реальное** (спуф clubId/чужая компания/не-линкованный получатель отклоняются). Счета/расходы/возврат-расчёт/cash-wallets/ОФД-идемпотентность — **реальное, сильнейшая зона**.
- **[РИСК P1] Invoice pay-guard + аудит — серверное исполнение только STRING-GUARD** (`pilot-invoice-ai-review.mjs:59` проверяет наличие строки, реальный action не исполняется). **[РИСК P1] Атомарность импорта — только STRING-GUARD** (`.includes("prisma.$transaction")`, откат не проверяется). Analytics — в основном string-guard. Аудит-эмиссия — string-guard. Файлы — реальное зеркало + string-guard.

**Отсутствующие сценарии (риск финошибки/утечки):** двойной сабмит Sale; дубль cash-операции; сбой аудита после закоммиченной оплаты; гонка двух ОФД-синков одной connection + краш; end-to-end реального `markInvoicePaid` guard; cross-tenant через `clubId`-only запросы; систематическая проверка month-close на всех путях записи.

---

## 11. Производительность [ФАКТ]/[ВЫВОД]

- **[РИСК P1] Веерные запросы дашборда.** `loadClubCashBalances` = 6 запросов/клуб, вызывается `Promise.all(clubIds.map(...))`; + поцикловый бюджет (`BUDGET_CATEGORIES`×2-3 findMany без границы даты). Без кэша, `force-dynamic`, ×компании на стратегическом пути. 50 клубов → сотни конкурентных запросов на загрузку; owner многих компаний насыщает пул.
- **[РИСК P1] Списки без пагинации + all-time сканы.** invoices/expenses/refunds/sales грузят все строки scope; `analytics.ts:205-206` сканирует все оплаченные счета/возвраты без границы даты, повторно на каждый рендер.
- **[РИСК P2] `ofdReceiptItem`** (крупнейшая таблица) агрегируется в памяти помесячно + reclassify построчно → на миллионах строк многосекундные сканы/OOM.
- **[РИСК P2]** `balance-snapshots` load-all + JS-дедуп; растёт с историей.
- **[ФАКТ]** нет кэша (`React cache`/`unstable_cache`) вовсе; `getCurrentCompanyAndClub` пересчитывает доступы несколько раз за запрос. ОФД date-колонки — строки, `startsWith(month)` (нужен индекс).
- **[РИСК P3]** `clubId`-only фин.запросы не используют companyId-ведущий индекс; ОФД per-receipt последовательные DocumentInfo-вызовы замедляют backfill.

**Масштаб:** 50→100 клубов — линейный рост фана + пул-лимиты; миллионы чеков/годы — агрегаты ОК, но безграничные сканы summary и raw-items — точки отказа; мульти-компания — стратегический per-company фан + `clubId`-only индексы.

---

## 12. Реестр рисков P0–P3

**Сводка:** P0 — 0 подтверждённых; P1 — 14; P2 — 21; P3 — 6.

### P0 — критические

**Нет подтверждённых P0.** [ВЫВОД] Явно проверено и **не найдено**: cross-tenant чтение/запись, изменение чужих фин.данных, обход изоляции компаний, раскрытие секретов, разрушительные операции без гарда. Двойная оплата защищена CAS. Ближайшие к P0 — P1-1…P1-4 (перенаправление платежа) — понижены до P1, т.к. требуют операционного доступа и не пересекают арендатора.

### P1 — высокие

Формат: **ID — Название** · Модуль · Файлы · Сценарий → Последствия · Существующая защита / почему недостаточна · Направление (без кода).

- **P1-1 — Флаг проверки ИИ не сбрасывается при редактировании.** Счета. `invoices/actions.ts:617,1129-1142` vs guard `:990`. Проверил low-conf → возврат → автор меняет сумму/счёт → resubmit → approve → pay проходит на устаревшем флаге. Последствие: оплата непроверенных/изменённых реквизитов. Защита — сам флаг, недостаточен (не обнуляется). Направление: сбрасывать `aiDataReviewedAt` при любой записи фин.полей.
- **P1-2 — Medium-confidence оплачивается без проверки.** Счета. `invoices/actions.ts:990`. `finalize()` ставит medium при слабом банковском/критич.поле; guard срабатывает только на low. Направление: расширить guard на medium или на непогашенные warnings.
- **P1-3 — Сумма/контрагент/реквизиты изменяемы после согласования, без переутверждения и отпечатка.** Счета. `invoices/actions.ts:673,688-707`; `INVOICE_REVIEW_DATA_STATUSES`. Regional согласовал 100 000₽ поставщику A → accountant/owner переписывает счёт и платит. Последствие: развязка согласования и оплаты (fraud invoice-redirection). Защита: нет (нет фингерпринта). Направление: фиксировать «отпечаток» согласованной суммы/реквизитов; блок оплаты при изменении после approve.
- **P1-4 — Нет истории прежних значений реквизитов/суммы.** Счета. `invoices/actions.ts:619-626,709-717`. Пост-approve изменение банковского счёта нерасследуемо. Направление: before/after в аудите фин.полей.
- **P1-5 — v1 edit расхода переносит строку в закрытый/будущий месяц.** Расходы. `expenses/actions.ts:400-437`. month-close проверяется по старой дате, новая не валидируется, будущие даты не запрещены. Направление: проверять month-close по новой дате + запрет будущего (как в v2).
- **P1-6 — v1 confirmed-расход свободно мутируется без переутверждения.** Расходы. `expenses/actions.ts:423-432`. Сумма/категория подтверждённого (учтённого) расхода меняется без гейта, без before/after. Направление: иммутабельность после confirmed (как v2 после verify).
- **P1-7 — Cross-module ручной двойной учёт.** Расходы/Возвраты. `analytics.ts:263-271`, `expenses.ts:60`. Одна операция как Refund/Invoice/payroll И как ручной Expense той же категории. Направление: гейтить категории `refunds`/`salary` в ручном вводе; дедуп-эвристика/предупреждение.
- **P1-8 — v1 `transitionRefund` не проверяет `entryVersion` → обход v2-контроля.** Возвраты. `refunds/actions.ts:265`. v2-draft (status `draft`) проводится через v1-трек до `paid` без v2-review/документов/расчёта. Направление: `if entryVersion!==1 throw` в v1-действиях.
- **P1-9 — v2-возвраты финансово невидимы (нет стадии оплаты).** Возвраты. `analytics.ts:206,211`, `budgets.ts`. Согласованный v2-возврат никогда не в spend/бюджете/долге. Направление: реализовать стадию оплаты v2 или включить `accounting_in_progress` в обязательства.
- **P1-10 — Устаревший расчёт возврата переотправляется.** Возвраты. `refund-document-actions.ts:243,345`; `refund-workflow.ts:56`. После correction меняют операнды без пересчёта; readiness не проверяет консистентность. Направление: требовать свежий пересчёт на submit или обнулять результат при смене операндов.
- **P1-11 — Живой контур наличных не проверяет month-close.** Наличные. `collections/actions.ts` (все create/review + opening). Инкассация/изъятие/«Иное»/контрольная точка создаются/одобряются в закрытом месяце. Направление: добавить `monthClosedError` в живой cash-контур.
- **P1-12 — Нет идемпотентности cash-операций.** Наличные. `collections/actions.ts:112,142,276`. Двойной сабмит = два pending, двойное движение баланса. Направление: dedup-ключ / client submission id (как у счетов).
- **P1-13 — Двойной сабмит `Sale` удваивает выручку.** Продажи/целостность. `sales/actions.ts:79`; нет dedup у `Sale`. Направление: `clientSubmissionId`-паттерн + unique.
- **P1-14 — Двойной учёт выручки Sale+SalesReport и нестабильный ОФД dedupeKey.** Analytics/ОФД. `analytics.ts:241`; `adapter.ts:26-31`. (а) Sale и SalesReport за ту же выручку суммируются; (б) разное наличие ФПД → два ключа → удвоение ОФД-выручки. Направление: единый источник выручки; стабилизировать dedupeKey на `fn:fd`.

> Смежные P1 из тестов/производительности (можно вести отдельно): **тесты** — атомарность импорта и серверный pay-guard/аудит только string-guard (`pilot-invoice-ai-review.mjs:59`, `pilot-plan-budget-imports.mjs:109`); **производительность** — веерные запросы дашборда и списки без пагинации (`dashboard-cards.ts:65`, `analytics.ts:205-206`). Импорт планов, обнуляющий пустые строки (`plan-import.ts:73-78`), также P1-класса (потеря данных).

### P2 — средние (21)

1. Cancel-статусы счёта расходятся; chief-approved нельзя отменить (`invoices/actions.ts:853`, `page.tsx:27`).
2. `INVOICE_STATUSES` пропускает live-статусы (`invoices.ts:83-92`).
3. Редактирование оплаченного счёта не ревалидирует analytics/dashboard/budgets (`invoices/actions.ts:628-629`).
4. month-close при edit счёта по старой дате (`invoices/actions.ts:611`).
5. v1-расход: будущие даты разрешены (`expenses/actions.ts:56-60`).
6. `pending_owner_budget_approval` недостижим (мёртвая ветка) (`simplified-actions.ts:200-214`).
7. Refund без `legalEntityId` (`schema.prisma:363`).
8. v2-возвраты не проверяют month-close (`refund-document-actions.ts`).
9. Уволенный тренер выбираем при расчёте (`refunds.ts:118`).
10. «Иное»/изъятие без двухстороннего подтверждения получателя в живом контуре (`collections/actions.ts:126-153`).
11. Same-day-as-checkpoint операции молча исключены (`cash-balances.ts:116`).
12. Retired System A всё ещё пишется (`simplified-actions.ts:293`), server actions экспортированы.
13. ОФД dev-fallback статичный ключ шифрования (`crypto.ts:14`).
14. ОФД дата-выручки зависит от таймзоны сервера (`adapter.ts:249`).
15. ОФД: нет обработки отменённых чеков.
16. ОФД-импорт: `OfdSyncRun` застревает в `running` при необёрнутом исключении (`importer.ts:225-236`).
17. Импорт планов/бюджетов: нет revert/истории + нет month-close (`plan-import-actions.ts:108`).
18. Аудит: нет БД-иммутабельности, нет IP/UA/before-after (`schema.prisma:624`, `access.ts:646`).
19. Аудит неатомарен с операцией → возможна закоммиченная операция без аудит-строки.
20. Файлы: orphan-объекты при удалении сущности; expense-doc Content-Type из хранимого MIME; нет антивируса; refund pay без ИИ-guard; prod-мисконфиг OpenAI шлёт документы за пределы РФ.
21. Уведомления: `skipped(no_connection)` не переотправляется; нет reaper для `sending` (`outbox.ts:65-77`).

### P3 — низкие (6)

1. `clubId`-only фин.запросы не паттерн-консистентны (`cash-collections.ts:38`).
2. cron-секрет `===` (тайминг) (`ofd/daily.ts:54`).
3. TOCTOU в создании cash-перевода (митигировано confirm) (`cash-wallets.ts:248`).
4. Токен бота в URL (инфра-логи) (`telegram/client.ts:18`).
5. Импорт: короткая запись «2,5» → 2.5₽ (риск 1000×) (`amount.ts:21-28`); копейки round vs manual.
6. Upload читается целиком в память (cap 10MB) — память при конкуренции.

---

## 13. Неоднозначности и вопросы владельцу продукта

1. **Два мира выручки.** Основная P&L считает выручку/прибыль по `Sale`+`SalesReport` (ручной ввод отчётов отключён), а реальная выручка — в ОФД-агрегатах, показанных отдельно. **Вопрос:** является ли Sale/SalesReport-выручка устаревшей, и должна ли прибыль строиться на ОФД? Нужен ли мост ОФД→выручка или единый источник?
2. **`createSale` всё ещё жив** (`sales/actions.ts:79`, gated `canCreateOperational`), хотя «продажи из ОФД». **Вопрос:** намеренно ли оставлен ручной ввод одиночных продаж, или это должно быть отключено как sales-reports?
3. **v1 vs v2 как активные пути.** v1-create расходов/возвратов остаётся вызываемым server action, хотя UI ведёт в v2. **Вопрос:** v1 сохранён для legacy/API или должен быть закрыт на чтение?
4. **Стадия оплаты v2-возвратов** не реализована — кто помечает paid, дебетует ли кошелёк, пишет ли `legalEntityId`? (Пока P1-9 не оценить против замысла.)
5. **Owner как редактор фин.полей счёта** (`canReviewInvoiceData` включает owner) — намеренно ли это против «стратегической read-only» модели?
6. **month-close в cash-контуре и в импортах планов/бюджетов** — намеренное исключение или упущение?
7. **Мульти-ИП клуб** — `calculateCashBalances` берёт один ИП; политика для клубов с несколькими ИП?
8. **«Иное» и «возврат»** — согласовать терминологию (касса vs ОФД) во избежание бухгалтерской путаницы.
9. **Эквайринг-комиссия** — где должна учитываться (авто из ОФД electronic vs ручной расход)?
10. **Судьба retired System A** (CashWallet/CashMovement) — удаление или планируемый реальный ledger?
11. **Спящий `superadmin`** — подтвердить, что ни миграция, ни сид его не присваивают.
12. **Архивные клубы в Analytics** — исключаются ли (не верифицировано в анализируемых файлах)?

---

## 14. Итоговые оценки (0–10)

| Критерий | Оценка | Обоснование |
|---|---|---|
| Архитектурная целостность | 7 | Чистые слои, централизованные роли/scope; минус — дублирующиеся «миры» (v1/v2, System A/B, Sale/ОФД). |
| Ясность бизнес-логики | 6 | Правила статусов централизованы и читаемы; но три функции месяца, два движка на модуль, мёртвые ветки. |
| Финансовая корректность | 5 | Нет двойного учёта счёт↔расход; но смешанная база признания, v2-возвраты невидимы, Sale+SalesReport дубль, эквайринг не учтён. |
| Бухгалтерская понятность | 5 | Честно управленческий контур; но термины «Иное»/«возврат»/«Результат vs Прибыль» путают. |
| Безопасность разделения компаний | 9 | Единый scoped-loader паттерн, валидированный cookie-scope, cross-tenant не найден. |
| Безопасность ролей | 8 | Проработанная матрица роль/капабилити/страница, серверно-энфорс; мелкие несоответствия (owner-edit, cancel-статусы). |
| Целостность данных | 6 | Транзакции + CAS в критичных путях; минус — нет идемпотентности у Sale/наличных, неатомарный аудит/ОФД. |
| Качество аудита действий | 6 | Широкое покрытие событий, безопасные payload, иммутабельность в коде; минус — нет IP/UA/before-after/БД-иммутабельности/атомарности. |
| Готовность к банковской интеграции | 3 | Нет модели эквайринга/способов оплаты/сеттлмента; только cash/electronic split. |
| Готовность к «ОФД-сверке» | 4 | Есть фискальные реквизиты и cash/electronic split; нет источника эквайринга и связей чек↔транзакция. |
| Масштабируемость | 4 | Веерные запросы дашборда, списки без пагинации, all-time сканы, нет кэша, in-memory ОФД-агрегация. |
| Качество тестов | 5 | Большой объём и сильные поведенческие зоны; но нет раннера/CI-ясности, критичные серверные пути — string-guard, мёртвые `.test.ts`. |
| Удобство сопровождения | 6 | Единые паттерны и подробные комментарии; минус — дублирующиеся движки и retired-но-живой код повышают когнитивную нагрузку. |

**Средневзвешенная оценка (ориентир): ~5.7/10** — крепкая безопасность и изоляция при среднем уровне финансовой согласованности, целостности идемпотентности и масштабируемости.

---

## 15. Рекомендуемый порядок дальнейших аудитов и исправлений

1. **Финансовая согласованность выручки (сначала решение продукта, затем аудит).** Определить единый источник выручки (ОФД vs Sale/SalesReport); проверить P1-14 (Sale+SalesReport дубль, ОФД dedupeKey).
2. **Целостность оплаты счетов (P1-1…P1-4).** Спроектировать: сброс флага проверки при edit, гейт medium, «отпечаток» согласованной суммы, before/after в аудите.
3. **Возвраты v2 (P1-8, P1-9, P1-10).** Закрыть v1-трек для v2 (`entryVersion`-guard), реализовать/оценить стадию оплаты, консистентность расчёта.
4. **Идемпотентность денежных вводов (P1-12, P1-13).** dedup-ключи для Sale и cash-операций; month-close в cash-контуре (P1-11).
5. **Расходы v1 (P1-5, P1-6, P1-7).** month-close по новой дате, иммутабельность после confirmed, гейтинг дублирующих категорий.
6. **Импорт планов (обнуление пустых, P1-класс) + revert/history + month-close.**
7. **ОФД устойчивость (P1 из OFD).** Стабилизировать dedupeKey, изоляция маппингов по connectionId, reaper застрявших `running`, таймзона.
8. **Наблюдаемость/аудит (P2).** before/after, IP/UA, транзакционный аудит или outbox, БД-иммутабельность.
9. **Производительность (P1 perf).** Пагинация списков, scope-wide grouped SQL вместо веера, границы дат, кэш access-резолвинга, `groupBy` для ОФД-items.
10. **Тесты (P1 tests).** Поведенческие тесты серверного pay-guard, атомарности импорта (реальный откат), гонок ОФД, дублей Sale/наличных.
11. **Готовность к сверке ОФД↔эквайринг.** Спроектировать модель эквайринга (RRN/terminal/settlement) — отдельный аудит перед реализацией.

---

*Конец отчёта. Изменялся только этот файл; код, схема и миграции не затронуты.*
