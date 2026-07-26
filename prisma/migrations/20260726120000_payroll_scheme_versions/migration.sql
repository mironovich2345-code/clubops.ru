-- Additive-only (SQLite dev): STAGE 12 versioned pay schemes. New nullable/defaulted
-- columns on EmployeePayScheme + a unique index on sourceChangeRequestId (idempotency).
-- No table rebuild, no data recompute, no legacy column touched. Existing rows read as
-- version=1, status='active'; backfill (payroll:scheme-backfill) refines status by dates.

ALTER TABLE "EmployeePayScheme" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "EmployeePayScheme" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "EmployeePayScheme" ADD COLUMN "payrollCategory" TEXT;
ALTER TABLE "EmployeePayScheme" ADD COLUMN "submittedById" TEXT;
ALTER TABLE "EmployeePayScheme" ADD COLUMN "submittedAt" DATETIME;
ALTER TABLE "EmployeePayScheme" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "EmployeePayScheme" ADD COLUMN "approvedAt" DATETIME;
ALTER TABLE "EmployeePayScheme" ADD COLUMN "activatedAt" DATETIME;
ALTER TABLE "EmployeePayScheme" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "EmployeePayScheme" ADD COLUMN "supersedesSchemeId" TEXT;
ALTER TABLE "EmployeePayScheme" ADD COLUMN "sourceChangeRequestId" TEXT;
ALTER TABLE "EmployeePayScheme" ADD COLUMN "comment" TEXT;

CREATE UNIQUE INDEX "EmployeePayScheme_sourceChangeRequestId_key" ON "EmployeePayScheme"("sourceChangeRequestId");
CREATE INDEX "EmployeePayScheme_status_idx" ON "EmployeePayScheme"("status");
