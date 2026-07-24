# Финализация финансового блока + ОФД + диагностика — аудит (Этап 1)

Дата: 2026-07-24 · ветка `main`. Аудит проведён инспекцией кода (4 параллельных обхода
подсистем: касса/финансы, ОФД/синхронизация, загрузка документов возврата, безопасность
настроек). Ниже — что уже есть, что переиспользуем, где риски, и краткий план реализации.

---

## A. Что уже реализовано (и что переиспользуем)

### A1. Касса — ДВА независимых контура (переиспользовать оба, не плодить остатки)
1. **Ledger кошельков** — `CashWallet` + `CashMovement` (`prisma/schema.prisma:964,994`),
   сервис `src/lib/cash-wallets.ts`. Баланс = Σ(confirmed toWallet) − Σ(confirmed
   fromWallet), **никогда не хранится** (`walletBalanceKopeks`). Направление: приток =
   `toWalletId`, отток = `fromWalletId`. Идемпотентность: `@@unique[sourceType, sourceId]`.
2. **Фактический остаток ООО/ИП** — чистая математика `calculateCashBalances`
   (`src/lib/cash-balances.ts:125`), загрузчик `loadClubCashBalances(companyId, clubId, now)`
   (`src/lib/cash-collections.ts:24`). Разделение по **юрлицу** (ООО vs ИП), не по типу
   кошелька. Опорная точка — последний `BalanceSnapshot` («контрольный остаток»), после неё
   считаются OFD-наличные и операции. Возвращает `cashOooFactBalance`, `cashIpFactBalance`,
   `cashOooOfdYesterday/Today`, `cashIpOfd...` и т. д.

> **Ключевой факт:** «ожидаемый расчётный остаток» **уже существует** — это
> `cashOooFactBalance` / `cashIpFactBalance`. Сверка = введённое управляющим фактическое
> количество **vs** это значение. Пересчитывать нельзя — вызывать `loadClubCashBalances`.

### A2. /collections
`src/app/(app)/collections/{page.tsx,actions.ts,_components/CollectionForms.tsx}`. Показывает
per-club карточки ООО/ИП (`OooCard`/`IpCard`), сворачиваемый «Контрольный остаток»
(`setCashOpeningBalance` → `BalanceSnapshot`), инкассацию ООО, изъятие ООО→ИП, приход «Иное».
`/balances` → `redirect("/collections")`. **Ежедневной сверки наличных (КМ-6) НЕТ** —
ближайшее — ad-hoc `BalanceSnapshot`, без дедлайна/расхождения/статусов.
- Права: `canCreateOperational` (manager|regional) — создание; `canSetOpeningBalance`
  (manager|regional|owner|GD|accountant|CA); `canReviewCollection`
  (accountant|CA|owner|GD), review изъятий добавляет regional. Клубный скоуп — `ctxForWrite`.

### A3. ОФД (Такском)
Модели `OfdConnection` (креды AES-256-GCM), `OfdCashRegisterMapping` (ФН→клуб+ЮЛ),
`OfdReceiptImport` (дедуп `dedupeKey @unique = taxcom:ФН:ФД[:ФПД]`), `OfdReceiptItem`
(`itemKey`), `OfdDailySalesSummary`, `OfdRevenueCategoryDailySummary`, `OfdSyncRun`,
`OfdSyncError`. Импортёр — `importTaxcomSalesForPeriod` (`src/lib/ofd/importer.ts`), нормализация
через `NormalizedOfdReceipt` (`src/lib/ofd/types.ts`). Провайдер **захардкожен на taxcom**
(`OFD_SUPPORTED_PROVIDERS=["taxcom"]`, `provider:"taxcom"` во всех фильтрах/записях), но во всех
моделях есть колонка `provider` → схема готова к мультипровайдерности.
- Ручная синхронизация: `syncOfdNowAction` (`settings/integrations/ofd/actions.ts:398`),
  гейт `requireOfdAdmin` = owner|GD, rate-limit 1/company/5min, `runSyncNowForCompany` (сегодня).
- Авто-синхронизация: `POST /api/cron/ofd/daily` (`src/app/api/cron/ofd/daily/route.ts`),
  auth `Bearer CRON_SECRET`/`X-Cron-Secret`, fail-closed (503 без флага/секрета, 401 неверный,
  405 не-POST). Гоняет `runDailyOfdImport` (вчера, server-local день) по всем активным
  taxcom-подключениям, **изоляция по подключению** (падение одного не рушит остальных).
- Здоровье: `GET /api/health` отдаёт только `{enabled, configured}`; дашборд-лоадер
  `loadOfdDashboardSummary` помечает `lastSyncFailed = lastRun.status==="failed"`.

### A4. Загрузка документов возврата (v2 slot)
Клиент `RefundDraftEditor.tsx` → server action `uploadRefundDocument`
(`refund-document-actions.ts:103`) → `storeRefundDocument` (`refund-document-storage.ts`) →
`RefundDocument` (одна активная строка на слот, `activeSlotKey @unique`). Валидация уже
структурированная: тип (JPG/PNG/WEBP/PDF), HEIC-имя, размер 10 МБ/файл, агрегат 40 МБ,
magic-bytes, доступ (`guardEditableDraft`). Storage — `getStorage()` (local|S3),
ключ = `refund-docs/<64hex>.<ext>` (имя файла НЕ используется как ключ).

### A5. Безопасность/роли
Session (`club_ops_session`, httpOnly, secure prod, 30д), bcrypt (`hashPassword`/
`verifyPassword`, cost 10), rate-limit (`checkRateLimit`/`peekRateLimit`,
`RateLimitBucket`), step-up через `action-challenge.ts` (httpOnly path-scoped cookie +
`EmailOtpChallenge` с `attemptCount/maxAttempts`). Роли: owner|GD|regional|manager|CA|
accountant|marketer; `can(roles, capability)`; owner — единственный с `month.reopen.approve`.
Секреты — AES-256-GCM (`src/lib/ofd/crypto.ts`, `OFD_SECRET`), resolveSecret-политика
(`src/lib/env-secrets.ts`).

---

## B. Где сейчас синхронизация и почему могла перестать работать

- **Ручная:** `syncOfdNowAction` в настройках ОФД (owner/GD). Работает.
- **Авто:** только route `POST /api/cron/ofd/daily`. **В репозитории НЕТ планировщика**
  (нет `vercel.json`; деплой Railway/Docker). Route обязан вызываться **внешним** systemd-
  таймером (описано в `docs/RU_DEPLOYMENT.md`).
- **Наиболее вероятные причины «авто-синк не работает» (для Этапа 7):**
  1. Внешний таймер не настроен на проде → route никогда не вызывается.
  2. `OFD_INTEGRATIONS_ENABLED` не выставлен → 503.
  3. `CRON_SECRET` не выставлен/не совпадает → 503/401.
  4. Часовой пояс сервера ≠ МСК: «вчера» считается по server-local дню (нет per-club TZ).
  5. Пагинация: клиент шлёт `pn=1, ps=100` без цикла — >100 чеков/смену или >100 смен/день
     **молча обрезаются** (`src/lib/ofd/taxcom/client.ts`).
  6. Такском отдаёт вчерашние чеки с задержкой (00:05–00:10) — запуск в 00:00 может опоздать.
- **Право ручного запуска сейчас:** только owner/GD (`requireOfdAdmin`). Regional видит
  ОФД-продажи, но запускать не может; accountant ОФД-раздел не видит вовсе.

---

## C. Загрузка документов возврата: что скрыто общим сообщением

Точки схлопывания всех причин в одно сообщение:
1. **Клиент `RefundDraftEditor.tsx:54`** — `catch { setError("Ошибка загрузки."); }`
   проглатывает **любую** брошенную ошибку без кода и без логирования.
2. **Сервер `refund-document-actions.ts:130`** — все сбои storage (S3 misconfig, сеть,
   AccessDenied, диск) схлопываются в один `STORAGE_FAILED`.
3. **Латентная ловушка (вероятная первопричина «иногда не прикрепляется»):** в Next-конфиге
   **нет** `serverActions.bodySizeLimit` → дефолт ~1 МБ, а файлы разрешены до 10 МБ. Файл
   1–10 МБ проходит клиентскую валидацию, но Server Action **отклоняет тело до входа в
   обработчик** → throw → попадает в bare-catch → «Ошибка загрузки». Прокси: Caddy 40 МБ,
   nginx 12 МБ.
4. HEIC ловится по имени/типу, но байтовый сниффер возврата (в отличие от расходов) не
   детектит HEIC-бренд; нет кодов `DUPLICATE`, `REQUEST_TOO_LARGE`, `UPLOAD_TIMEOUT`,
   `NETWORK_ERROR`, раздельного `STORAGE_UNAVAILABLE`/`STORAGE_WRITE_FAILED`,
   `DATABASE_WRITE_FAILED`.

Лучший образец для переиспользования — `src/lib/expense-document-{storage,errors}.ts`
(типизированный `DocErrorCode`, HEIC-байты, `DUPLICATE`).

---

## D. Что потребуется для Астрал.ОФД

- **Провайдер-абстракции нет** — Такском вшит. Нужен интерфейс `OfdProvider`
  (обобщить `TaxcomClient`), реестр провайдеров, ветвление фабрики клиента по
  `connection.provider`. Схема уже несёт `provider` везде → миграции моделей не нужны.
- **Нормализованный DTO уже есть** (`NormalizedOfdReceipt`) — аналитика/агрегаты работают
  после нормализации независимо от провайдера. Переиспользовать.
- **Блокеры (реальные):** нет аккаунта Астрал.ОФД, нет API-ключа, нет доступа к их кабинету
  и официальной документации из этой среды. По правилу №7 **нельзя** называть интеграцию
  готовой без реального запроса с действующими реквизитами. → Астрал будет реализован как
  **provider skeleton + discovery-документ + test-connection contract + fixtures + mapping
  tests**, со статусом **BLOCKED BY CREDENTIALS/DOCUMENTATION**, честно.

---

## E. Какие секреты/доступы отсутствуют

- `OFD_INTEGRATIONS_ENABLED`, `OFD_SECRET` (≥32), `CRON_SECRET` — нужны на проде для ОФД и
  cron (иначе 503). Проверить их наличие на реальном деплое (инфраструктурно).
- Внешний systemd-таймер на `/api/cron/ofd/daily` — вне репозитория; проверить на проде.
- `STORAGE_PROVIDER`/`S3_*` — если s3, при отсутствии → `STORAGE_FAILED` на загрузке.
- **Астрал.ОФД:** API-ключ/логин, базовый URL, идентификатор организации/касс, тариф с API,
  официальная документация — **отсутствуют** (запросить у владельца аккаунта).
- Новое: `SETTINGS_PIN` не нужен (ПИН — bcrypt-хэш в БД, не reversible-секрет). Session/rate-
  limit секреты уже есть.

---

## F. Краткий план реализации (неблокирующие пункты — делаем)

| Этап | Суть | Ключевое переиспользование | Риск/примечание |
|---|---|---|---|
| 2. Фактические деньги | Новая модель `DailyCashReconciliation` (запись-подтверждение, НЕ баланс) + блок на `/collections` | `loadClubCashBalances` (ожидаемый остаток + OFD-нал), `BalanceSnapshot`, `recordAudit`, outbox | Не двигать деньги; не переписывать ОФД; дедлайн 12:00 server-local (нет per-club TZ — зафиксировано) |
| 3. Dashboard OFD sync | Компактный блок «Данные ОФД» + кнопка | Существующий `runSyncNowForCompany`, rate-limit, importer-lock | Новая capability `ofd.sync.trigger` (server-side), не трогать settings-actions |
| 4. Settings PIN | `Company.settingsPinHash/…/primaryOwnerUserId` + verification-session + guard | bcrypt, rate-limit, `action-challenge` cookie-паттерн | Не пароль юзера; primaryOwner — явное поле + бэкофилл; гейтить приоритетные критичные actions |
| 5. Астрал.ОФД | Provider interface + Taxcom adapter + Astral skeleton + discovery/fixtures/mapping tests | `NormalizedOfdReceipt`, `provider` колонка | **BLOCKED BY CREDENTIALS** — честно; не ломать Taxcom |
| 6. Refund upload | `serverActions.bodySizeLimit` + структурные коды + точные сообщения + observability | `expense-document-errors` как образец | Первопричина — body limit + bare-catch |
| 7. OFD auto-sync | Health-статус + диагностика + (возможно) фикс пагинации + docs | `OfdSyncRun`, importer | Первопричина — внешний таймер/env; фикс пагинации только если контракт очевиден |
| 8/9 | Тесты + per-stage gauntlet + коммиты + финальный отчёт | pilot-*.mjs харнесс | — |

**Блокирующей нехватки внешних реквизитов для этапов 2,3,4,6,7 нет** — реализуем. Этап 5
(Астрал live) блокирован реквизитами → делаем foundation + честный статус.

Принципы (соблюдаются во всех этапах): не ломать финансовый/payroll/ОФД-контур; не плодить
остатки; не дублировать в ledger; не делать разрушающих миграций (только nullable/новые
таблицы); все проверки прав server-side; все новые операции — `recordAudit`; после каждого
блока — prisma validate (dev+prod), tsc, lint/tests, next build + build:prod.
