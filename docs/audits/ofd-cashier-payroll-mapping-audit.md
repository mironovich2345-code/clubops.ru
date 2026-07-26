# Аудит: связь ОФД-кассир → сотрудник → payroll (STAGE 13)

Аудит **до** изменения расчёта payroll. Цель: безопасная атрибуция личной выручки сотрудника по
конкретным фискальным чекам через **подтверждённый** mapping кассира ОФД → Employee; возврат
уменьшает выручку исходного сотрудника; unmatched/ambiguous не распределяются молча.

Файлы: `prisma/schema.prisma` (OFD-модели), `src/lib/ofd/{importer,astral/*,taxcom/*,types}.ts`,
`src/lib/payroll/sales-bases.ts`, `src/lib/sales-plans.ts`, `src/app/(app)/payroll/periods/actions.ts`.

## Ключевые находки (определяют архитектуру этапа)
- **Модели `OfdReceipt` НЕТ.** «Чек» — это `OfdReceiptImport` (`schema.prisma:1910`): fnNumber,
  fiscalDocumentNumber, fiscalSign, `operationType (income | income_return)`, receiptDate,
  totals, `dedupeKey @unique`, provider. **Поля кассира НЕТ** ни в `OfdReceiptImport`, ни в
  `OfdReceiptItem`.
- **Кассир нигде не сохраняется.** Только Astral парсит `operator ?? cashier`
  (`astral/receipts.ts:243`), но значение **отбрасывается** в `toNormalizedReceipt`/`persistPage`
  — в БД не попадает. Taxcom **не читает значение** кассира, лишь детектирует наличие FFD-тегов
  1021/1203 как диагностику (`taxcom/adapter.ts:221-230`).
- **Связи возврата с исходной продажей НЕТ.** Возврат — обычная строка `income_return` со своим
  `dedupeKey`; нет поля/фискальной обратной ссылки/доменной модели. Correction-чеки
  **отбрасываются** обоими провайдерами (не бронируются).
- **Личная выручка payroll — полностью ручная.** `getClubPlanFactBases` берёт факт из
  **`SalesReport`** (ручные подтверждённые отчёты), НЕ из ОФД (`sales-plans.ts:98`). Комментарий
  в `sales-bases.ts:3-5` прямо фиксирует: «per-employee sales attribution в данных нет».
- **Cross-provider dedupe только внутри провайдера.** `dedupeKey` префиксован провайдером
  (`taxcom:…` / `astral:…`), поэтому один физический чек из двух провайдеров дал бы ДВЕ строки.
  На практике один ФН привязан к одному провайдеру (конфигурацией, не констрейнтом).
- **У `ClubEmployee` нет alias-полей** — только `fullName`, `status`, `dismissedAt`, `hireDate`.

## 14 вопросов
1. **ФИО кассира от Taxcom.** Не приходит в значении: адаптер читает только КЛЮЧИ тегов
   1021 (ФИО кассира) / 1203 (ИНН), значение не извлекается. → для Taxcom-чеков кассир пока
   отсутствует.
2. **Поля от Astral.** Raw ticket содержит `operator`/`cashier` (строка ФИО); нормализуется в
   `cashier` (`receipts.ts:243`), плюс парсятся (но не сохраняются) `kktRegId, inn, ofdTime` и др.
3. **Стабильность cashier/operator.** Строка ФИО — нестабильна (регистр, инициалы, опечатки,
   разный формат в Taxcom vs Astral). Нельзя использовать как ключ атрибуции.
4. **Provider-specific ID кассира.** Явного стабильного `externalCashierId` провайдеры не дают
   (Astral — только ИНН кассира, опционально; Taxcom — тег 1203 ИНН, значение не читается).
5. **Нормализация ФИО.** Сейчас отсутствует. Нужна чистая `normalizeCashierName` (trim, lower,
   пробелы, ё→е, пунктуация, порядок инициалов, Unicode NFC) — только для **предложений**.
6. **Связь возврата с продажей.** Нет. Порядок поиска будущей атрибуции: (1) прямая OFD-ссылка
   (отсутствует в данных) → (2) фискальные идентификаторы исходного чека → (3) доменная связь
   (нет) → (4) ручное сопоставление → (5) `requires_review`.
7. **Идентификатор исходного чека в возврате.** В текущих данных возврат не несёт fiscal-id
   исходной продажи. → большинство возвратов уйдут в ручную очередь (`unmatched_refund`).
8. **Чеки без кассира.** Все Taxcom-чеки + Astral-чеки без operator. → identity не создаётся;
   атрибуция невозможна → показываем «чеки без атрибуции».
9. **Correction receipts.** Отбрасываются на импорте (не бронируются). Учитывать только
   фискализированные income/income_return; correction в личную выручку не входят.
10. **Где вводится ручная выручка.** `collectPeriodInput` (`periods/actions.ts:231/235/265`):
    `netPersonalSales`/`sales`/`personalSales` → хранится в `salesBaseKopeks`. Форма —
    `CalculationCard.tsx`. Это ручной ввод per employee/период.
11. **Защита закрытого периода.** `isPayrollPeriodClosed`/`Locked`; recompute читает stored
    automatic (не пере-считывает формулу закрытого месяца); snapshot immutable. Новые чеки не
    должны менять закрытый период.
12. **Риск двойной атрибуции.** (а) один чек дважды в одну выручку → нужен unique
    (receipt+type); (б) один чек из двух провайдеров → стабильный fiscal-fingerprint; (в)
    возврат, назначенный кассиру возврата вместо исходного менеджера.
13. **Данные для backfill.** operatorName в чеке (появится только после добавления поля и
    пере-синка/новых чеков — исторические Taxcom/Astral чеки кассира НЕ содержат). firstSeen/
    lastSeen, receiptsCount, sum — агрегируются из чеков с operatorName.
14. **Что нельзя объединять автоматически.** Одинаковое ФИО из разных company / ofdConnection /
    provider / кассы / юрлица — разные identities. Fuzzy-match — только suggestion с confidence.

## Целевые решения (кратко)
- **Захват кассира (аддитивно):** новые колонки на `OfdReceiptImport` — `operatorName?`,
  `operatorNormalized?`, `externalCashierId?`. Astral-импортер начинает их писать; Taxcom
  оставляет null (значение недоступно) → безопасно `unmatched`.
- **Новые модели (аддитивно):** `OfdCashierIdentity` (кассир в конкретном источнике),
  `OfdCashierMapping` (identity → employee, статусы/effective-интервалы/matchMethod),
  `PayrollSalesAttribution` (per-receipt, идемпотентно, `@@unique(receiptImportId, attributionType)`).
  Aliases сотрудника = несколько mappings разных identity на одного employee.
- **normalizeCashierName** — чистая; fuzzy только как suggestion.
- **Атрибуция:** только `confirmed`/`manually_assigned` mapping, по дате чека в пределах
  effective-интервала + employment; sale → +employee, refund → −исходный employee (по fiscal-id),
  иначе `unmatched_refund`. Идемпотентно, dedupe по fiscal-fingerprint.
- **Возврат прошлого закрытого периода:** относится к исходному менеджеру, но **уменьшает
  выручку в текущем открытом периоде даты возврата**, со ссылкой на исходную продажу/период;
  закрытый период не меняется. (Зафиксировано в тестах.)
- **Sales snapshot payroll (аддитивно на `PayrollCalculation`):** `automaticSalesKopeks`,
  `manualSalesOverrideKopeks?`, `manualSalesComment?`, `effectiveSalesKopeks`, `salesSource`.
  Preview ≠ apply; один attribution-сервис. Не перезаписывать ручное молча.
- **Category-level materialization (остаток STAGE 12):** `schemeScope (employee | payroll_category)`
  на `PayrollChangeRequest`; scope=payroll_category → версия с `employeeId=null` для категории.

## Не менять
Формулы, role_categories_v2, финансовые движения, STAGE 9 транши, snapshot прошлых расчётов,
ОФД-агрегаты дашбордов. Payroll rework НЕ объявляется завершённым. Telegram/PWA/кадры — вне scope.
