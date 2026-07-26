-- Non-destructive additive migration (production PostgreSQL) — STAGE 10–11 change
-- requests. New table + one nullable column on PayrollCalculation. No ALTER TYPE,
-- no table rebuild, no recompute of existing data. Pending change requests never
-- affect any total; only an approved request applies a change.

ALTER TABLE "PayrollCalculation" ADD COLUMN "approvedOverridesJson" TEXT;

CREATE TABLE "PayrollChangeRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "employeeId" TEXT,
    "payrollPeriodId" TEXT,
    "payrollCalculationId" TEXT,
    "payrollSchemeId" TEXT,
    "requestType" TEXT NOT NULL,
    "fieldType" TEXT NOT NULL,
    "targetField" TEXT,
    "categoryKey" TEXT,
    "oldValueJson" TEXT,
    "proposedValueJson" TEXT NOT NULL,
    "calculatedImpactKopeks" INTEGER,
    "impactUncomputable" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "regionalComment" TEXT,
    "reviewerComment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "historyJson" TEXT,
    "appliedToken" TEXT,
    "appliedAdjustmentId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollChangeRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollChangeRequest_appliedToken_key" ON "PayrollChangeRequest"("appliedToken");
CREATE INDEX "PayrollChangeRequest_companyId_idx" ON "PayrollChangeRequest"("companyId");
CREATE INDEX "PayrollChangeRequest_clubId_idx" ON "PayrollChangeRequest"("clubId");
CREATE INDEX "PayrollChangeRequest_employeeId_idx" ON "PayrollChangeRequest"("employeeId");
CREATE INDEX "PayrollChangeRequest_payrollPeriodId_idx" ON "PayrollChangeRequest"("payrollPeriodId");
CREATE INDEX "PayrollChangeRequest_payrollCalculationId_idx" ON "PayrollChangeRequest"("payrollCalculationId");
CREATE INDEX "PayrollChangeRequest_status_idx" ON "PayrollChangeRequest"("status");
