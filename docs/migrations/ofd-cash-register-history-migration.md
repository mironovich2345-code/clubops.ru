# Миграция: история касс ОФД (привязки + ФН)

`20260728100000_ofd_cash_register_history` — **аддитивная**, non-destructive. Dev (SQLite) +
prod (PostgreSQL).

## Что добавляется
- **`OfdCashRegisterMapping`**: `status` (active | disabled | archived | deleted, default
  active), `archivedAt`, `deletedAt`. Индекс по `status`. Backfill не нужен — существующие
  строки читаются как `active`.
- **`OfdCashRegisterAssignment`** — effective-dated история привязки (клуб / юрлицо /
  подключение / тип), end-exclusive интервалы. Смена привязки закрывает текущую и открывает
  новую; прошлые чеки не трогаются.
- **`OfdFiscalDrive`** — история ФН одной ККТ (`fiscalDriveNumber`, `registrationNumber`,
  `validFrom/To`, `status` active|replaced|archived, `externalId`).

## Что НЕ трогается
`OfdReceiptImport`/`OfdReceiptItem`/агрегаты/`dedupeKey` — существующие поля и данные. Чеки уже
хранят `clubId`/`legalEntityId`/`fnNumber` на момент импорта → историческая целостность
обеспечена на уровне чека; новые модели дают явную аудируемую историю. Нет DROP/ALTER COLUMN.

## Порядок (dev)
`migrate deploy` dev → `prisma generate` → `prisma:sync-prod`. Prod — `migrate deploy` prod.

## Инварианты
- Смена привязки/ФН не переписывает импортированные чеки.
- `activeMappingKey @unique` — один активный ФН на (provider, fn).
- Архив/удаление сохраняют историю; полное удаление — только owner + PIN + typed FN, блок при
  закрытом периоде.
