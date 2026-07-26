-- Non-destructive additive migration (production PostgreSQL) — advance tranches.
-- New table + nullable columns; legacy columns kept. No ALTER TYPE, no DROP, no rebuild,
-- no recompute of existing data.

ALTER TABLE "PayrollAdvance" ADD COLUMN "requestedAmountKopeks" INTEGER;
ALTER TABLE "PayrollAdvance" ADD COLUMN "approvedAmountKopeks" INTEGER;
ALTER TABLE "PayrollAdvance" ADD COLUMN "linkedPayrollCalculationId" TEXT;

CREATE TABLE "PayrollAdvancePayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "employeeAdvanceId" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentMethod" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "cashSource" TEXT,
    "expenseId" TEXT,
    "cashMovementId" TEXT,
    "paymentReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "createdByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,
    "reversalReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollAdvancePayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollAdvancePayment_idempotencyKey_key" ON "PayrollAdvancePayment"("idempotencyKey");
CREATE INDEX "PayrollAdvancePayment_employeeAdvanceId_idx" ON "PayrollAdvancePayment"("employeeAdvanceId");
CREATE INDEX "PayrollAdvancePayment_companyId_idx" ON "PayrollAdvancePayment"("companyId");
CREATE INDEX "PayrollAdvancePayment_clubId_idx" ON "PayrollAdvancePayment"("clubId");
