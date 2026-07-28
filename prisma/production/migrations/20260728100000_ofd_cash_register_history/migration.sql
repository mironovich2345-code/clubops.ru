-- Non-destructive additive migration (production PostgreSQL) — cash-register management
-- history. New status columns + two history tables. No ALTER TYPE, no rebuild, no recompute.
-- Existing rows read status='active'.

ALTER TABLE "OfdCashRegisterMapping" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "OfdCashRegisterMapping" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "OfdCashRegisterMapping" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "OfdCashRegisterMapping_status_idx" ON "OfdCashRegisterMapping"("status");

CREATE TABLE "OfdCashRegisterAssignment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "cashRegisterMappingId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "connectionId" TEXT NOT NULL,
    "cashRegisterType" TEXT NOT NULL DEFAULT 'club_cashbox',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdById" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OfdCashRegisterAssignment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OfdCashRegisterAssignment_companyId_idx" ON "OfdCashRegisterAssignment"("companyId");
CREATE INDEX "OfdCashRegisterAssignment_cashRegisterMappingId_idx" ON "OfdCashRegisterAssignment"("cashRegisterMappingId");
CREATE INDEX "OfdCashRegisterAssignment_clubId_idx" ON "OfdCashRegisterAssignment"("clubId");

CREATE TABLE "OfdFiscalDrive" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'taxcom',
    "connectionId" TEXT NOT NULL,
    "cashRegisterMappingId" TEXT NOT NULL,
    "fiscalDriveNumber" TEXT NOT NULL,
    "registrationNumber" TEXT,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OfdFiscalDrive_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OfdFiscalDrive_companyId_idx" ON "OfdFiscalDrive"("companyId");
CREATE INDEX "OfdFiscalDrive_cashRegisterMappingId_idx" ON "OfdFiscalDrive"("cashRegisterMappingId");
CREATE INDEX "OfdFiscalDrive_fiscalDriveNumber_idx" ON "OfdFiscalDrive"("fiscalDriveNumber");
