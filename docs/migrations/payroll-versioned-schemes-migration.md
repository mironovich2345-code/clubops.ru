# Миграция: версионируемые схемы зарплаты (STAGE 12)

`20260726120000_payroll_scheme_versions` — **аддитивная**, non-destructive. Dev (SQLite) +
prod (PostgreSQL).

## Что добавляется в `EmployeePayScheme`
Колонки (все nullable/defaulted): `version` (default 1), `status` (default 'active'),
`payrollCategory`, `submittedById/At`, `approvedById/At`, `activatedAt`, `archivedAt`,
`supersedesSchemeId`, `sourceChangeRequestId` (+ `@unique` индекс — идемпотентность
материализации), `comment`. Индекс по `status`.

## Что НЕ трогается
`paramsJson`, `effectiveFrom/effectiveTo`, `schemeType`, `position`, `employeeId` — существующие
данные и бизнес-параметры. Нет `DROP` / `ALTER COLUMN` / `RENAME` / rebuild. Прошлые
`PayrollCalculation.schemeSnapshotJson` неизменны (snapshot обогащается только для НОВЫХ
расчётов; старые читают новые ключи как undefined).

## Порядок применения (production, §22)
```
# 0. backup БД
# 1. аудит существующих схем (read-only)
npm run payroll:scheme-audit
# 2. миграция
npx prisma migrate deploy --schema prisma/production/schema.prisma
# 3. backfill dry-run → проверить conflicts/ambiguous
node scripts/payroll-scheme-backfill.mjs
# 4. backfill apply
node scripts/payroll-scheme-backfill.mjs --apply
# 5. повторный аудит
npm run payroll:scheme-audit
# 6. проверить resolver/новую версию/период до и после effectiveFrom на тестовом клубе
```
(В деве: `npx prisma migrate deploy --schema prisma/schema.prisma` +
`npx prisma generate --schema prisma/schema.prisma` + `npm run prisma:sync-prod`.)

## Backfill (`payroll:scheme-backfill`)
В пределах логического ключа `(company|club|employee?ALL|position)` строки сортируются по
`effectiveFrom` (затем `createdAt`) и получают `version` 1..N; `status`: `superseded` если
`effectiveTo != null`, иначе `scheduled` если дата в будущем, иначе `active`; `supersedesSchemeId`
= предыдущая версия. **DRY-RUN по умолчанию**, `--apply` пишет. Used-схемы: меняются только
новые метаданные (version/status/supersedes), бизнес-параметры не трогаются. **Неоднозначные**
ключи (две версии с одинаковым `effectiveFrom`) пропускаются — manual review, не угадываем.

## Идемпотентность и безопасность
- `sourceChangeRequestId @unique` → одна заявка = одна версия; повтор возвращает существующую.
- Resolver считает «живыми» только `approved/scheduled/active/superseded` и выбирает по дате
  периода; ≥2 живых версии на дату → conflict (блок).
- Откат: данные аддитивны, старый код игнорирует новые поля. Полный откат — только когда ни
  одна версия не материализована.
