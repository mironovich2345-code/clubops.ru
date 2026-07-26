-- Additive-only (SQLite dev): STAGE 10–11 change requests. New table +
-- one nullable column on PayrollCalculation (approvedOverridesJson). No table
-- rebuild, no data recompute, no legacy column touched. Pending change requests
-- never affect any total; only an approved request applies a change.

ALTER TABLE "PayrollCalculation" ADD COLUMN "approvedOverridesJson" TEXT;

CREATE TABLE "PayrollChangeRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "effectiveFrom" DATETIME,
    "reason" TEXT NOT NULL,
    "regionalComment" TEXT,
    "reviewerComment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "historyJson" TEXT,
    "appliedToken" TEXT,
    "appliedAdjustmentId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" DATETIME,
    "submittedAt" DATETIME,
    "reviewedById" TEXT,
    "reviewedAt" DATETIME,
    "returnedAt" DATETIME,
    "rejectedAt" DATETIME,
    "cancelledAt" DATETIME,
    "appliedById" TEXT,
    "appliedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PayrollChangeRequest_appliedToken_key" ON "PayrollChangeRequest"("appliedToken");
CREATE INDEX "PayrollChangeRequest_companyId_idx" ON "PayrollChangeRequest"("companyId");
CREATE INDEX "PayrollChangeRequest_clubId_idx" ON "PayrollChangeRequest"("clubId");
CREATE INDEX "PayrollChangeRequest_employeeId_idx" ON "PayrollChangeRequest"("employeeId");
CREATE INDEX "PayrollChangeRequest_payrollPeriodId_idx" ON "PayrollChangeRequest"("payrollPeriodId");
CREATE INDEX "PayrollChangeRequest_payrollCalculationId_idx" ON "PayrollChangeRequest"("payrollCalculationId");
CREATE INDEX "PayrollChangeRequest_status_idx" ON "PayrollChangeRequest"("status");
