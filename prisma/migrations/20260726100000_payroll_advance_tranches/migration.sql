-- Additive-only (SQLite dev): advance tranches. New table + nullable columns on
-- PayrollAdvance. Legacy columns (amountKopeks, expenseId, paidAt, status) are kept and
-- untouched; existing advances keep working. No table rebuild, no data recompute.

ALTER TABLE "PayrollAdvance" ADD COLUMN "requestedAmountKopeks" INTEGER;
ALTER TABLE "PayrollAdvance" ADD COLUMN "approvedAmountKopeks" INTEGER;
ALTER TABLE "PayrollAdvance" ADD COLUMN "linkedPayrollCalculationId" TEXT;

CREATE TABLE "PayrollAdvancePayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "employeeAdvanceId" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "paidAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentMethod" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "cashSource" TEXT,
    "expenseId" TEXT,
    "cashMovementId" TEXT,
    "paymentReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "createdByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "reversedAt" DATETIME,
    "reversedByUserId" TEXT,
    "reversalReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PayrollAdvancePayment_idempotencyKey_key" ON "PayrollAdvancePayment"("idempotencyKey");
CREATE INDEX "PayrollAdvancePayment_employeeAdvanceId_idx" ON "PayrollAdvancePayment"("employeeAdvanceId");
CREATE INDEX "PayrollAdvancePayment_companyId_idx" ON "PayrollAdvancePayment"("companyId");
CREATE INDEX "PayrollAdvancePayment_clubId_idx" ON "PayrollAdvancePayment"("clubId");
