# Отчёт: интеграция Saby ОФД (СБИС) — аудит + скелет

Начало интеграции через **официальный API** (`api.sbis.ru`), кабинет <https://ofd.saby.ru/>.
Provider `saby` за флагом `OFD_SABY_ENABLED` (OFF). Payroll и другие модули не расширялись.

## Итог (§27, часть Saby)
9. **Официальные API.** Подтверждено: auth (X-SBISSessionID / X-SBISAccessToken),
   `GET /ofd/v1/orgs/<inn>/kkts`, `.../kkts/<regId>/storages?status=` (несколько ФН на ККТ),
   `.../storages/<storageId>/docs`, `/ofd/v1/storage/<storageId>/doc?docNum=&fiscalSign=&docDate=`;
   FFD-JSON.
10. **Authentication.** Сессия СБИС на online.sbis.ru → заголовок `X-SBISSessionID`; для ОФД —
    `X-SBISAccessToken` + `sid` cookie. Точное тело — проверить на кабинете.
11-12. **ККТ/ФН/чек.** ККТ по org, ФН (storages) по ККТ, документы по ФН, документ по
    реквизитам; позиции/оплаты/СНО — по FFD-тегам.
13. **Cashier.** FFD-тег 1021; отдаёт ли Saby значение — проверить (как Astral vs Taxcom).
14. **Возврат↔продажа.** Стандартной обратной ссылки нет → фискальные идентификаторы / ручная
    очередь; переиспользуем `PayrollSalesAttribution` (не относим кассиру возврата).
15. **Dedupe.** `buildProviderDedupeKey("saby",…)` + провайдеро-независимый fiscal fingerprint —
    один физический чек влияет один раз, в т.ч. если пришёл и из Taxcom/Astral.
16. **Incremental.** По ФН → docs с датой + overlap-window; идемпотентность через dedupeKey.
17. **Credentials.** Encrypted, без логов, SSRF host-allowlist, retry auth 1 раз, timeouts.
18-19. **UI/Mobile.** Provider registry + honest status; полноценный setup-wizard Saby —
    следующий шаг после подтверждения auth на кабинете.
20. **Тесты.** `pilot:ofd-saby` 15/0 (нормализация/host/статус/эндпоинты — без живого API).

## Ограничения официального API (§27.22) и что проверить (§27.23)
Точные JSON-ключи чека, тело auth-запроса, cursor/limit пагинации, rate-limits, ссылка возврата
на продажу, права методов — **до подтверждения на реальном кабинете не выдумываются**; provider
остаётся `blocked_by_credentials`. Перед включением: сверка итогов/позиций/возвратов/оплат на
одной кассе за ограниченный период.
