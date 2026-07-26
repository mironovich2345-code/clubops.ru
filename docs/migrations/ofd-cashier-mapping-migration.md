# Миграция: ОФД кассир → payroll атрибуция (STAGE 13)

`20260726130000_ofd_cashier_payroll_attribution` — **аддитивная**, non-destructive. Dev
(SQLite) + prod (PostgreSQL).

## Что добавляется
- **`OfdReceiptImport`**: `operatorName`, `operatorNormalized`, `externalCashierId` (nullable).
  Astral-импортер начинает их писать; Taxcom оставляет null (значение кассира не читается) →
  такие чеки безопасно `unmatched`. Историческим чекам поля = NULL (кассир недоступен ретроактивно).
- **`OfdCashierIdentity`** — кассир в конкретном источнике (`identityKey @unique`: company|
  provider|connection|fn|normalizedName). Идентичные ФИО из разных источников — разные identity.
- **`OfdCashierMapping`** — identity → employee; статусы (auto_matched/confirmed/unmatched/
  ambiguous/manually_assigned/excluded/inactive), matchMethod, effective-интервалы, confirmedBy.
- **`PayrollSalesAttribution`** — per-receipt атрибуция; `dedupeKey @unique` (fiscal
  fingerprint + тип) → один физический чек влияет один раз (в т.ч. cross-provider).
- **`PayrollCalculation`**: `automaticSalesKopeks`, `manualSalesOverrideKopeks?`,
  `manualSalesComment?`, `effectiveSalesKopeks`, `salesSource`, `salesSyncedAt`.
- **`PayrollChangeRequest`**: `schemeScope` (employee | payroll_category).

## Что НЕ трогается
Существующие receipt/receipt-item поля, dedupeKey, суммы, формулы, финансовые движения,
snapshot прошлых расчётов. Нет `DROP` / `ALTER COLUMN` / `RENAME` / rebuild.

## Production rollout (§35)
```
# 0. backup БД; начать с ОДНОГО клуба и ОДНОГО месяца
npm run payroll:ofd-cashier-audit          # read-only, без ПДн
npx prisma migrate deploy --schema prisma/production/schema.prisma
node scripts/payroll-ofd-cashier-backfill.mjs           # dry-run
# проверить ambiguous/unmatched
node scripts/payroll-ofd-cashier-backfill.mjs --apply   # только identities + suggestions
# mappings НЕ подтверждаются автоматически — подтвердить вручную на пилотном клубе
# → preview продаж в payroll → сверить с фактической таблицей → apply только после сверки
npm run payroll:ofd-attribution-audit      # dedupeKey уникальность, спорные возвраты
```
(Dev: `migrate deploy` dev + `prisma generate` + `prisma:sync-prod`.)

## Инварианты
- Атрибуция только через `confirmed`/`manually_assigned` mapping.
- `identityKey @unique` — нет случайного merge источников.
- `PayrollSalesAttribution.dedupeKey @unique` — идемпотентность per receipt.
- Возврат → исходный сотрудник (по ссылке), иначе `unmatched_refund` (ручная очередь).
- Закрытый/согласованный период не меняется автоматически.
- Откат: данные аддитивны; старый код игнорирует новые поля/таблицы.
