-- Additive-only (SQLite dev): cash-register management history. New status columns on
-- OfdCashRegisterMapping + two history tables (binding + fiscal-drive). No rebuild, no data
-- recompute, no legacy column touched. Existing rows read status='active'.

ALTER TABLE "OfdCashRegisterMapping" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "OfdCashRegisterMapping" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "OfdCashRegisterMapping" ADD COLUMN "deletedAt" DATETIME;

CREATE INDEX "OfdCashRegisterMapping_status_idx" ON "OfdCashRegisterMapping"("status");

CREATE TABLE "OfdCashRegisterAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "cashRegisterMappingId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "connectionId" TEXT NOT NULL,
    "cashRegisterType" TEXT NOT NULL DEFAULT 'club_cashbox',
    "effectiveFrom" DATETIME NOT NULL,
    "effectiveTo" DATETIME,
    "createdById" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OfdCashRegisterAssignment_companyId_idx" ON "OfdCashRegisterAssignment"("companyId");
CREATE INDEX "OfdCashRegisterAssignment_cashRegisterMappingId_idx" ON "OfdCashRegisterAssignment"("cashRegisterMappingId");
CREATE INDEX "OfdCashRegisterAssignment_clubId_idx" ON "OfdCashRegisterAssignment"("clubId");

CREATE TABLE "OfdFiscalDrive" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'taxcom',
    "connectionId" TEXT NOT NULL,
    "cashRegisterMappingId" TEXT NOT NULL,
    "fiscalDriveNumber" TEXT NOT NULL,
    "registrationNumber" TEXT,
    "validFrom" DATETIME,
    "validTo" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'active',
    "externalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "OfdFiscalDrive_companyId_idx" ON "OfdFiscalDrive"("companyId");
CREATE INDEX "OfdFiscalDrive_cashRegisterMappingId_idx" ON "OfdFiscalDrive"("cashRegisterMappingId");
CREATE INDEX "OfdFiscalDrive_fiscalDriveNumber_idx" ON "OfdFiscalDrive"("fiscalDriveNumber");
