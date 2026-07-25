# Астрал.ОФД — реализация

**Статус: READY FOR CREDENTIALS.** Код полностью реализован по официальной документации
(«Документация Астрал ОФД API.pdf», v4.2). Провайдер не помечается «LIVE/Подключено», пока
не выполнен реальный запрос с действующим `api_key` и не сверён хотя бы один тестовый день
(правило №7). Discovery/ограничения — `astral-ofd-discovery.md`; чек-лист живого пилота —
`docs/testing/astral-ofd-pilot.md`.

## 1. Архитектура (переиспользование, без второго контура)

```
/settings/ofd/astral  (шаги 1–5)
      │ api_key (AES-256-GCM в OfdConnection.integrationTokenEncrypted)
      ▼
AstralApiClient (src/lib/ofd/astral/client.ts)   POST + api_key, retry, error-map
      ▼
api.ts (каталог) + receipts.ts (нормализация) + importer.ts (documents.tickets)
      ▼  NormalizedOfdReceipt (ОБЩИЙ DTO)
существующий пайплайн: OfdReceiptImport → OfdReceiptItem → categorizeItem →
OfdDailySalesSummary → OfdRevenueCategoryDailySummary → дашборд/аналитика/Фактические деньги
```

Astral не создаёт новых экранов, контуров или таблиц чеков. Общая кнопка синхронизации и
cron `/api/cron/ofd/daily` обрабатывают taxcom+astral независимо.

## 2. Endpoints (v4.2; Z-отчёт v4.1)

| Метод | Назначение | Где |
|---|---|---|
| `organization.list` | организации; **testConnection** (search="" page=1 count=10) | api.ts `listOrganizations` |
| `kkt.aliasList` | торговые точки (пагинация) | `listOutlets` |
| `kkt.search` | кассы организации | `listKkts` |
| `kkt.listByAlias` | кассы точки | `listKktsByAlias` |
| `kkt.getById` | детали/диагностика кассы | `getKktById` |
| **`documents.tickets`** | **основной импорт чеков** (пагинация) | `fetchReceiptsPage` → importer |
| `documents.closedShiftsList` | сверка (смены: sum/cash/ecash/checkCount) | `fetchClosedShifts` |
| `documents.shiftTickets` | диагностика/добор позиций смены | (резерв) |
| `analytics.aliases` | контрольные суммы (profit/cash/ecash/refunds) | `fetchAnalyticsSummary` |
| `document.zReport` (v4.1) | диагностика одной смены | (не в основном sync) |

## 3. Авторизация и клиент

- Base URL `https://ofd.astralnalog.ru/api/v4.2`. Все методы POST, тело JSON, авторизация
  параметром **`api_key`** (никогда не header/URL). Конверт `{ok,result}` / `{ok:false,error_code,description}`.
- `AbortController` timeout (30с). Ограниченный exponential backoff (400мс→5с) только для
  5xx/429/timeout/network. **Нет retry** для 400/401/403/404. Толерантный парсинг
  string|number|boolean. Защита от malformed JSON. reference id + structured logs.
- **`api_key` никогда не логируется** и не попадает в тексты ошибок (`redactApiKey`).
- Внутренние коды: `ASTRAL_INVALID_API_KEY` (401), `ASTRAL_ACCESS_DENIED` (403),
  `ASTRAL_KKT_NOT_FOUND` (404), `ASTRAL_RATE_LIMITED` (429), `ASTRAL_SERVICE_UNAVAILABLE` (5xx),
  `ASTRAL_TIMEOUT`, `ASTRAL_INVALID_RESPONSE`, `ASTRAL_PAGINATION_ERROR`,
  `ASTRAL_ORGANIZATION_NOT_FOUND`/`ASTRAL_ALIAS_NOT_FOUND`, `ASTRAL_SYNC_PARTIAL_FAILURE`,
  `ASTRAL_NOT_CONFIGURED`.

## 4. Основной sync (documents.tickets)

- Минимальный production-запрос: `organizationId`, `pageNumber`, `count`, `orderBy="dateTime"`,
  `order="asc"`, `beginDate`/`endDate`, `kkts[]` (или `fiscalDriveNumber[]` из mapping),
  `operationTypes=["Приход","Возврат прихода"]`. Лишние фильтры не отправляются.
- **Таймзона:** `beginDate/endDate` — unix seconds в **Europe/Moscow (UTC+3)**, не в таймзоне
  сервера (`moscowDayRangeUnix`).

## 5. Пагинация и идемпотентность

- `pageNumber` (1-based) + `count` (100), `result.documents[]` + `result.totalCount`
  (string|number). Цикл до `documentsReceived >= totalCount`; пустая страница завершает цикл;
  guard `DEFAULT_MAX_PAGES`; детект повторяющейся страницы (первый dedupeKey совпал) →
  `ASTRAL_PAGINATION_ERROR`. Каждая страница пишется идемпотентно до продвижения.
- **Уникальный ключ чека** = `OfdReceiptImport.dedupeKey` (unique) =
  `astral:<fiscalDriveNumber>:<fd>:<fiscalSign>`, где `fd = fiscalDocumentNumber ?? checkNumber`.
  `fiscalSign` уникален в рамках ФН → один и тот же `checkNumber` на другом ФН/ККТ не
  коллидирует. Повтор/перекрытие периода, повтор страницы, partial failure → без дублей.
  Ключ Такском не менялся.

## 6. Типы документов и операции (провизорно, стандарт ФФД)

- `documentType` 3/4/21/31 — чек продажи/БСО/коррекция (несут выручку); 1/2/5/6/11/41 —
  служебные. `operationType` 1 приход → **income**, 2 возврат прихода → **income_return**,
  3 расход / 4 возврат расхода → не выручка, 0/неизвестно → служебный.
- В выручку идут только `sale`/`sale_return`. `expense`/`expense_return`/`service`/`unknown`
  **не** попадают в выручку и `OfdRevenueCategoryDailySummary`, но считаются диагностикой
  (`unknownDocuments` и др. в `OfdSyncRun`). Неизвестная комбинация — `unknown`, а не
  молчаливая продажа. Сырые `documentType`/`operationType` сохраняются. **Подтвердить на
  реальном дне** до массового импорта.

## 7. Суммы, оплаты, возвраты, номенклатура

- Все суммы **в копейках** (без ×100). `cashKopeks = cash`;
  `electronicKopeks = ecash + credit + prepaid + provision`; `totalKopeks = sum`.
- Сверка `cash+ecash+credit+prepaid+provision` против `sum`: при расхождении — флаг
  (`paymentMismatchCount`), импорт не блокируется, исходные значения сохраняются.
- Возврат (income_return) уменьшает выручку/наличные/электронные/категорию/дневные сводки.
- Позиции: только реально пришедшее (`name`, `count`; `price/sum` не выдумываются — 0 коп).
  Категоризация — существующая (`normalizedItemName` + `categorizeItem` +
  `OfdRevenueCategoryDailySummary`), без второго классификатора.

## 8. Хранение (аддитивная миграция)

`OfdConnection`: `externalOrganizationId`, `syncStartDate`. `OfdCashRegisterMapping`:
`externalOrganizationId`, `externalAliasId`, `externalKktId` (Такском оставляет null;
`fnNumber` = `factoryFiscalDrive`, `kktRegNumber` = `kktRegID`). `OfdSyncRun`:
`pagesProcessed`, `documentsReceived`, `unknownDocuments`, `durationMs`. Только ADD COLUMN /
CREATE INDEX — без DROP/rebuild, dev(SQLite)+prod(PostgreSQL).

## 9. Настройки, роли, ПИН, безопасность

- Экран `/settings/ofd/astral`, шаги 1–5. Только owner/general_director (server-side, иначе
  redirect). Менеджер критичных настроек не видит.
- **ПИН настроек** обязателен для: сохранения/замены api_key, выбора организации, привязки
  LegalEntity, привязки/отвязки кассы, вкл/выкл подключения. НЕ требуется для: обзора, статуса,
  `testConnection` сохранённым ключом, preview без изменения настроек.
- Tenant-safe: LegalEntity/Club обязаны принадлежать компании; чужой external id привязать
  нельзя; sync не использует чужую OfdConnection. api_key — AES-256-GCM, не возвращается
  клиенту, не логируется. Аудит: test, выбор организации, привязка/отвязка кассы, вкл/выкл,
  ручной импорт, cron.

## 10. Дашборд и cron

- Блок «Данные ОФД» показывает провайдеры отдельными чипами; Астрал становится «Подключено»
  только после реального успешного импорта (иначе «Требует API-ключ»/«Требует настройки»).
- Общая кнопка и `POST /api/cron/ofd/daily` берут taxcom+astral; per-connection try/catch
  изолирует падение одного провайдера от другого; отдельного endpoint/кнопки на провайдера нет.

## 11. Тесты

`npm run pilot:ofd-astral` — 50 проверок: клиент/парсинг/ошибки/retry, классификация
документов и оплат, пагинация/идемпотентность, реальная БД (импорт только выручки, отсутствие
дублей, дневная сводка, tenant isolation), статические guard'ы (безопасность, endpoints,
общий пайплайн, миграция, неизменность Такском). Живой пилот — `docs/testing/astral-ofd-pilot.md`.
