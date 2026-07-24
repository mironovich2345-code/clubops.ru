-- Non-destructive additive migration (production PostgreSQL) — trainer packages.
-- New table only; no ALTER/DROP/rebuild of existing tables.
CREATE TABLE "PayrollTrainerPackage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "payrollCalculationId" TEXT NOT NULL,
    "clientRef" TEXT,
    "contractNumber" TEXT,
    "saleDate" TIMESTAMP(3),
    "contractAmountKopeks" INTEGER NOT NULL DEFAULT 0,
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "sessionPriceKopeks" INTEGER NOT NULL DEFAULT 0,
    "trainerRateBp" INTEGER,
    "providedSessions" INTEGER NOT NULL DEFAULT 0,
    "returnedSessions" INTEGER NOT NULL DEFAULT 0,
    "refundKopeks" INTEGER NOT NULL DEFAULT 0,
    "seniorTrainerConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "seniorTrainerUserId" TEXT,
    "documentKey" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollTrainerPackage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PayrollTrainerPackage_payrollCalculationId_idx" ON "PayrollTrainerPackage"("payrollCalculationId");
CREATE INDEX "PayrollTrainerPackage_companyId_idx" ON "PayrollTrainerPackage"("companyId");
CREATE INDEX "PayrollTrainerPackage_clubId_idx" ON "PayrollTrainerPackage"("clubId");
CREATE INDEX "PayrollTrainerPackage_employeeId_idx" ON "PayrollTrainerPackage"("employeeId");
