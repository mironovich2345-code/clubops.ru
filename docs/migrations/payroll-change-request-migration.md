# Миграция: заявки на изменение зарплаты (STAGE 10–11)

`20260726110000_payroll_change_requests` — **аддитивная**, обратимая на уровне данных
(новые сущности не читаются старым кодом). Применяется в dev (SQLite) и prod (PostgreSQL).

## Что добавляется
1. **Таблица `PayrollChangeRequest`** — процесс «регионал предложил → ГД/собственник решил».
   Хранит тип (period_adjustment | future_scheme_change), поле (percentage | base_salary |
   one_time_bonus | threshold | tier | scheme_parameters), targetField, old/new значения (JSON),
   рассчитанное влияние, статус, ревизию, append-only `historyJson`, `appliedToken` (@unique —
   идемпотентность применения), ссылки на calc/scheme/period/employee, авторов и таймстемпы.
2. **Колонка `PayrollCalculation.approvedOverridesJson`** (nullable, TEXT) — согласованные
   override поверх base snapshot. Итог = snapshot + approved overrides + ручные inputs. Base
   snapshot никогда не переписывается.

## Что НЕ трогается
`PayrollAdjustment`, `schemeSnapshotJson`, `calculationEngineVersion`, суммы/выплаты/авансы,
финансовые сущности. Нет `DROP` / `ALTER COLUMN` / `RENAME` / rebuild. Backfill не нужен
(исторических заявок нет; существующие расчёты читают `approvedOverridesJson = NULL` и работают
как раньше).

## Порядок применения
```
# dev (SQLite)
npx prisma migrate deploy --schema prisma/schema.prisma
npx prisma generate --schema prisma/schema.prisma
npm run prisma:sync-prod          # регенерирует prisma/production/schema.prisma

# prod (PostgreSQL) — деплой-пайплайн
npx prisma migrate deploy --schema prisma/production/schema.prisma
```
Оба файла миграции написаны вручную и идентичны по семантике (различие только в диалекте:
`DATETIME` ↔ `TIMESTAMP(3)`, `PRIMARY KEY` inline ↔ `CONSTRAINT`, `BOOLEAN DEFAULT false`).

## Откат
Данные аддитивны: старый код игнорирует новую таблицу и колонку. Полный откат (если
потребуется) — `DROP TABLE "PayrollChangeRequest"` + `ALTER TABLE "PayrollCalculation" DROP
COLUMN "approvedOverridesJson"`; выполнять только когда ни одна заявка не применена (иначе
потеряются согласованные override — сначала перенести их в base scheme).

## Инварианты, которые обеспечивает схема
- `appliedToken @unique` → один согласованный запрос применяется РОВНО один раз.
- `approvedOverridesJson` отдельно от `schemeSnapshotJson` → воспроизводимость и отсутствие
  «тихой» перезаписи snapshot.
- Индексы по companyId/clubId/employeeId/payrollPeriodId/payrollCalculationId/status → быстрая
  очередь и close-guard.
