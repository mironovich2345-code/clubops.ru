# Отчёт: ОФД кассир → payroll атрибуция (STAGE 13)

Реализовано: OfdCashierMapping + автоматическая личная выручка + связь ОФД→сотрудник→продажи→
payroll + атрибуция возвратов + ручная очередь + category-level materialization (остаток STAGE
12). Не менялись: формулы, финансовые движения, snapshot прошлых расчётов. Payroll rework НЕ
завершён.

## Финальный отчёт (§36)
1. **Доступные поля кассира.** Только Astral даёт строку ФИО оператора (`operator/cashier`);
   Taxcom — лишь наличие тегов 1021/1203 (значение не читается). Persist добавлен: `operatorName`
   /`operatorNormalized` на `OfdReceiptImport` (Astral пишет, Taxcom null).
2. **Identity.** `OfdCashierIdentity`, `identityKey @unique` = company|provider|connection|fn|
   normalizedName — кассир в конкретном источнике; идентичные ФИО из разных источников не мержатся.
3. **Нормализация.** `normalizeCashierName` (NFC, lower, ё→е, пунктуация, пробелы, сорт токенов) —
   без потери частей и без surname-only; fuzzy `nameConfidence` только как suggestion.
4. **auto/confirmed/ambiguous.** Точное уникальное ФИО активного сотрудника в окне занятости →
   `auto_matched` (предложение). Несколько → `ambiguous`. Нет → `unmatched`. Атрибуция только по
   `confirmed`/`manually_assigned`.
5. **Aliases.** Несколько mapping разных identity на одного сотрудника = алиасы; основное ФИО
   Employee не меняется.
6. **Атрибуция чека.** `PayrollSalesAttribution` per receipt; продажа → сотрудник кассира смены
   (mapping, покрывающий дату чека).
7. **Дубли.** `dedupeKey @unique` (fiscal fingerprint + тип) — чек влияет один раз.
8. **Taxcom/Astral.** Fingerprint провайдеро-независим → один физический чек = один dedupeKey.
9. **Возврат → исходная продажа.** По ссылке `originalSaleReceiptId` (существующая атрибуция);
   fallback на кассира возврата **не используется**.
10. **Без исходной продажи.** `unmatched_refund` / спорный возврат → ручная очередь; случайного
    менеджера не уменьшаем.
11. **Возврат прошлого периода.** Закрытый период не меняется; возврат уменьшает выручку в
    текущем открытом периоде даты возврата со ссылкой на исходную продажу/период.
12. **Automatic sales → payroll.** `applyPeriodSales` пишет атрибуции + обновляет
    `automaticSalesKopeks`/`effectiveSalesKopeks`/`salesSource` + пересчёт по формуле роли.
13. **Manual override.** `manualSalesOverrideKopeks` перекрывает автоматику; никогда не теряется;
    источник `mixed` при наличии обоих.
14. **Preview ≠ apply.** Оба через один attribution-сервис; preview read-only, apply пишет
    атрибуции + snapshot + recompute (схему не меняет, денег не двигает).
15. **Статусы периода.** Draft — авто; on-review — предупреждение; approved/paid — не менять;
    closed — read-only (`isPayrollPeriodLocked` guard).
16. **Category-level materialization.** `schemeScope=payroll_category` → версия `employeeId=null`
    для категории; employee-specific версии сохраняют приоритет; идемпотентно.
17. **Роли.** Управляющий — read-only + предложить распределение чека; регионал — подтверждать
    свои клубы; ГД/owner — tenant; бухгалтер — read-only. Все проверки server-side.
18. **Tenant isolation.** company/club/connection/receipt/employee scoping + IDOR real-DB тесты.
19. **Backfill scripts.** `payroll:ofd-cashier-audit`, `payroll:ofd-cashier-backfill` (dry-run
    default), `payroll:ofd-attribution-audit` — счётчики + hashed IDs, без ПДн.
20. **Тестовые данные.** В деве база пуста; пилот создаёт identities/mappings/attributions
    прогонно и проверяет ambiguous/unmatched/idempotency.
21. **Mobile.** Список кассиров карточками, sales-блок и mapping-действия ≥44px, без raw JSON —
    от 320px.
22. **Тесты/build.** `pilot:payroll-ofd-cashier-mapping` 42/0; tsc/next build/build:prod/prisma
    validate dev+prod зелёные; `pilot:full` зелёный.
23. **Commit hashes.** Серия `feat/test/docs(payroll): STAGE 13 item N …` (см. `git log`).
24. **Остаточные ограничения.** Taxcom-кассир (тег 1021) пока не извлекается в значении → такие
    чеки `unmatched` (безопасно). Исторические чеки без кассира не восстановимы ретроактивно.
    Автоматическая связь возврат→продажа возможна только по существующей ссылке (в данных ОФД
    прямой обратной ссылки нет) → большинство возвратов ручные. Trainer new/renewal и group
    classification из OFD item-данных пока не автоклассифицируются (requires_classification /
    ручной ввод). club_manager АБ/ПТ — из существующих OFD-агрегатов, без cashier mapping.
25. **STAGE 14.** Извлечение Taxcom-кассира (тег 1021); автоклассификация trainer new/renewal и
    ГП из OFD item-категорий; авто-линковка возвратов по фискальным идентификаторам; пороги
    уведомлений о нераспределённой выручке; глобальный STAGE 14 / PWA.

## Критерии завершённости STAGE 13
Кассир ОФД → Employee через подтверждённый mapping ✔; личная выручка по конкретным чекам ✔;
возврат → исходный сотрудник ✔; unmatched/ambiguous не распределяются молча ✔; повторный sync
без дублей ✔; закрытые периоды неизменны ✔; preview ≠ apply ✔; manual override не теряется ✔;
category-level future scheme request создаёт реальную category-level версию ✔; новые экраны на
mobile от 320px ✔.

## Тесты
`npm run pilot:payroll-ofd-cashier-mapping` — 42 (12 pure + 14 static + 16 real-DB).
