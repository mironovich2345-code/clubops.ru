-- AlterTable (additive, in-place; scalar-id tables — no rebuild)
ALTER TABLE "PayrollPayment" ADD COLUMN "expenseId" TEXT;
ALTER TABLE "PayrollAdvance" ADD COLUMN "expenseId" TEXT;
