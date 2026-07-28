# Аудит: интеграция Saby ОФД / СБИС ОФД (официальный API)

Провайдер: **Saby ОФД** (provider code `saby`, legacy «СБИС ОФД»). Кабинет:
<https://ofd.saby.ru/>. Источник — **официальная документация API** Saby/СБИС (не scraping
интерфейса): <https://saby.ru/help/ofd/api>. Base API host: **`api.sbis.ru`**, auth host:
**`online.sbis.ru`**.

> Страницы справки Saby рендерятся клиентски (SPA), поэтому ниже зафиксированы **подтверждённые
> из поиска официальные эндпоинты**; точные имена JSON-полей чека и тела auth-запроса помечены
> «проверить на реальном кабинете» — **не выдумывать поля до подтверждения** (§11).

## 14 вопросов
1. **Authentication.** Сессия СБИС: аутентификация на `online.sbis.ru`, далее в каждом запросе
   HTTP-заголовок **`X-SBISSessionID: <sid>`**. Для веб-сервиса ОФД документирован вариант с
   **`X-SBISAccessToken`** + `sid` в Cookie. Прикладная авторизация — через `app_client_id`
   (сервисная учётка приложения). Точное тело запроса — `saby.ru/help/ofd/api/auth` /
   `saby.ru/help/integration/api/authentication` (проверить на кабинете).
2. **Credentials.** Логин/пароль сервисной учётки СБИС + идентификатор приложения
   (`app_client_id`) / токен доступа. Хранить **encrypted at rest**, не возвращать в UI.
3. **Список организаций.** По ИНН доступной учётке организации (`<inn>` — параметр путей ниже).
4. **Список ККТ.** `GET https://api.sbis.ru/ofd/v1/orgs/<inn>/kkts` («Список ККТ по организации»).
5. **Список ФН.** `GET https://api.sbis.ru/ofd/v1/orgs/<inn>/kkts/<regId>/storages?status=<status>`
   — возвращает ВСЕ установленные ФН ККТ + активный. Архитектурно подтверждает несколько ФН на
   одну ККТ последовательно (§4/`OfdFiscalDrive`).
6. **Документы по ФН.** `GET https://api.sbis.ru/ofd/v1/orgs/<inn>/kkts/<regId>/storages/<storageId>/docs`
   — список фискальных документов ФН (пагинация/фильтр по дате — проверить параметры).
7. **Полный чек и позиции.** `GET https://api.sbis.ru/ofd/v1/storage/<storageId>/doc?docNum=<docNum>&fiscalSign=<fiscalSign>&docDate=<docDate>`
   — фискальный документ по реквизитам. Представление — FFD-JSON («Представление фискальных
   документов в JSON», `/help/ofd/api/json`). Позиции/суммы/оплаты — по FFD-тегам.
8. **Cashier/operator.** FFD-тег **1021 (кассир)** входит в стандарт; **отдаёт ли Saby его
   значение — проверить** на реальном чеке (как у Astral operator vs Taxcom «только ключ»). Если
   отдаёт → `operatorName`/`operatorNormalized`; если нет → null → `unmatched` (не угадывать).
9. **Возврат ↔ исходная продажа.** Тип операции есть (приход/возврат прихода/коррекция).
   Стандартной обратной ссылки возврата на исходный чек в FFD нет → приоритет: официальная
   ссылка (если появится) → фискальные идентификаторы → ручная очередь. Переиспользуем
   существующий `PayrollSalesAttribution` (возврат НЕ относим кассиру возврата).
10. **Fiscal identifiers.** `fiscalDriveNumber` (ФН/storageId), `fiscalDocumentNumber` (docNum),
    `fiscalSign` (ФПД), `registrationNumber` (РНМ ККТ/regId), `docDate`. Достаточно для общего
    `receiptFiscalFingerprint` (fn:fd:sign:type) и dedupe (§15).
11. **Пагинация / rate limits.** По документации ОФД-API — постранично; точные cursor/limit и
    лимиты запросов проверить (§16 overlap-window + checkpoint по странице).
12. **Права.** Часть методов требует прав доступа сервисной учётки к организации/ОФД; уточнить
    required permissions на кабинете.
13. **Incremental sync.** Возможен: по ФН → docs с фильтром по дате + overlap-window для поздних
    документов; идемпотентность через существующий provider-dedupeKey (`saby:fn:fd:sign`).
14. **Чего нет.** Точные имена JSON-полей (cashier/items/оплаты), тело auth-запроса, cursor-имена,
    rate limits, ссылка возврата на продажу — **до подтверждения на реальном кабинете**.

## Целевая архитектура (переиспользование существующего)
- Provider registry: добавить `saby` (status `blocked_by_credentials` до реальной проверки) —
  как Astral-скелет. Интерфейс `OfdProvider` (testConnection) уже есть.
- `SabyOfdClient` (adapter): authenticate / re-auth (один retry) / testConnection /
  listCashRegisters / listFiscalDrives / listDocuments / getReceipt / normalizeProviderError.
  Host-allowlist `api.sbis.ru`,`online.sbis.ru`; timeouts; лимит параллелизма; не логировать
  секреты/сырой payload.
- Нормализация → существующий `NormalizedOfdReceipt` (+ STAGE 13 `operatorName`/
  `externalCashierId`), dedupeKey через `buildProviderDedupeKey("saby", …)`.
- Feature flag **`OFD_SABY_ENABLED`** (по умолчанию OFF): UI/actions Saby доступны только
  owner/system_admin при включённом флаге; один тестовый кабинет.

## Безопасность (§21)
Секреты encrypted (`decryptOfdSecret`/crypto как у Taxcom/Astral); маскирование в UI; фиксированный
host-allowlist (SSRF); timeouts + лимит размера ответа; retry-limit (auth 1 раз, без бесконечного
цикла); tenant/IDOR guards; без raw payload в проде; audit изменений подключения.

## Что проверить на реальном кабинете (§27.23)
Тело auth-запроса и lifetime сессии/токена; точные JSON-ключи чека (в т.ч. tag 1021 кассир,
позиции, оплаты, СНО); параметры пагинации и rate limits; наличие ссылки возврата на исходный
чек; required permissions методов.
