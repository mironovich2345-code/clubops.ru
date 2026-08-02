-- CreateTable
CREATE TABLE "PayrollPaymentObligation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT,
    "legalEntityId" TEXT NOT NULL,
    "payrollPeriodId" TEXT NOT NULL,
    "payrollType" TEXT NOT NULL,
    "payrollCategory" TEXT NOT NULL,
    "employeeId" TEXT,
    "amountKopeks" INTEGER NOT NULL,
    "paidKopeks" INTEGER NOT NULL DEFAULT 0,
    "remainingKopeks" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'planned',
    "sourceCalculationId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollPaymentObligation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPaymentObligation_idempotencyKey_key" ON "PayrollPaymentObligation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PayrollPaymentObligation_companyId_idx" ON "PayrollPaymentObligation"("companyId");

-- CreateIndex
CREATE INDEX "PayrollPaymentObligation_clubId_dueDate_idx" ON "PayrollPaymentObligation"("clubId", "dueDate");

-- CreateIndex
CREATE INDEX "PayrollPaymentObligation_payrollPeriodId_idx" ON "PayrollPaymentObligation"("payrollPeriodId");

-- CreateIndex
CREATE INDEX "PayrollPaymentObligation_legalEntityId_idx" ON "PayrollPaymentObligation"("legalEntityId");

-- CreateIndex
CREATE INDEX "PayrollPaymentObligation_status_idx" ON "PayrollPaymentObligation"("status");

