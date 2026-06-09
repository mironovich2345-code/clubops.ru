-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "expensePeriod" TEXT;

-- Backfill (Part 7): expensePeriod = month(invoiceDate) else month(paidAt) else
-- month(createdAt). Idempotent: only rows where expensePeriod is still NULL.
UPDATE "Invoice"
SET "expensePeriod" = to_char(COALESCE("invoiceDate", "paidAt", "createdAt"), 'YYYY-MM')
WHERE "expensePeriod" IS NULL;

