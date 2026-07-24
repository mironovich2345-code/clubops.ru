-- Non-destructive additive migration (production PostgreSQL) — payroll payment/advance
-- → salary Expense link. In-place ADD COLUMN; no DROP/rebuild.
ALTER TABLE "PayrollPayment" ADD COLUMN "expenseId" TEXT;
ALTER TABLE "PayrollAdvance" ADD COLUMN "expenseId" TEXT;
