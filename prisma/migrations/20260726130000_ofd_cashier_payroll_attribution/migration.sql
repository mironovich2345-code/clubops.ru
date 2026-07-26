-- Additive-only (SQLite dev): STAGE 13 OFD cashier → employee attribution. New nullable
-- columns on OfdReceiptImport (operator capture), PayrollCalculation (sales snapshot) and
-- PayrollChangeRequest (schemeScope); three new tables. No rebuild, no data recompute, no
-- legacy column touched. Existing receipts read operator* as NULL → cashier unmatched.

ALTER TABLE "OfdReceiptImport" ADD COLUMN "operatorName" TEXT;
ALTER TABLE "OfdReceiptImport" ADD COLUMN "operatorNormalized" TEXT;
ALTER TABLE "OfdReceiptImport" ADD COLUMN "externalCashierId" TEXT;

ALTER TABLE "PayrollCalculation" ADD COLUMN "automaticSalesKopeks" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PayrollCalculation" ADD COLUMN "manualSalesOverrideKopeks" INTEGER;
ALTER TABLE "PayrollCalculation" ADD COLUMN "manualSalesComment" TEXT;
ALTER TABLE "PayrollCalculation" ADD COLUMN "effectiveSalesKopeks" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PayrollCalculation" ADD COLUMN "salesSource" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "PayrollCalculation" ADD COLUMN "salesSyncedAt" DATETIME;

ALTER TABLE "PayrollChangeRequest" ADD COLUMN "schemeScope" TEXT;

CREATE TABLE "OfdCashierIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'taxcom',
    "ofdConnectionId" TEXT NOT NULL,
    "cashRegisterMappingId" TEXT,
    "legalEntityId" TEXT,
    "clubId" TEXT,
    "externalCashierId" TEXT,
    "rawName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL,
    "receiptsCount" INTEGER NOT NULL DEFAULT 0,
    "salesAmountKopeks" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "identityKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "OfdCashierIdentity_identityKey_key" ON "OfdCashierIdentity"("identityKey");
CREATE INDEX "OfdCashierIdentity_companyId_idx" ON "OfdCashierIdentity"("companyId");
CREATE INDEX "OfdCashierIdentity_ofdConnectionId_idx" ON "OfdCashierIdentity"("ofdConnectionId");
CREATE INDEX "OfdCashierIdentity_clubId_idx" ON "OfdCashierIdentity"("clubId");
CREATE INDEX "OfdCashierIdentity_status_idx" ON "OfdCashierIdentity"("status");

CREATE TABLE "OfdCashierMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'taxcom',
    "ofdConnectionId" TEXT NOT NULL,
    "cashRegisterMappingId" TEXT,
    "cashierIdentityId" TEXT NOT NULL,
    "employeeId" TEXT,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'auto_matched',
    "matchMethod" TEXT NOT NULL DEFAULT 'exact_normalized_name',
    "confidence" INTEGER,
    "effectiveFrom" DATETIME NOT NULL,
    "effectiveTo" DATETIME,
    "confirmedById" TEXT,
    "confirmedAt" DATETIME,
    "excludedReason" TEXT,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "OfdCashierMapping_companyId_idx" ON "OfdCashierMapping"("companyId");
CREATE INDEX "OfdCashierMapping_cashierIdentityId_idx" ON "OfdCashierMapping"("cashierIdentityId");
CREATE INDEX "OfdCashierMapping_employeeId_idx" ON "OfdCashierMapping"("employeeId");
CREATE INDEX "OfdCashierMapping_clubId_idx" ON "OfdCashierMapping"("clubId");
CREATE INDEX "OfdCashierMapping_status_idx" ON "OfdCashierMapping"("status");

CREATE TABLE "PayrollSalesAttribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "payrollPeriodId" TEXT,
    "payrollCalculationId" TEXT,
    "ofdReceiptId" TEXT NOT NULL,
    "attributionType" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "originalSaleReceiptId" TEXT,
    "mappingId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'attributed',
    "source" TEXT NOT NULL DEFAULT 'ofd_confirmed',
    "assignedById" TEXT,
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" DATETIME,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PayrollSalesAttribution_dedupeKey_key" ON "PayrollSalesAttribution"("dedupeKey");
CREATE INDEX "PayrollSalesAttribution_companyId_idx" ON "PayrollSalesAttribution"("companyId");
CREATE INDEX "PayrollSalesAttribution_clubId_idx" ON "PayrollSalesAttribution"("clubId");
CREATE INDEX "PayrollSalesAttribution_employeeId_idx" ON "PayrollSalesAttribution"("employeeId");
CREATE INDEX "PayrollSalesAttribution_payrollCalculationId_idx" ON "PayrollSalesAttribution"("payrollCalculationId");
CREATE INDEX "PayrollSalesAttribution_ofdReceiptId_idx" ON "PayrollSalesAttribution"("ofdReceiptId");
CREATE INDEX "PayrollSalesAttribution_status_idx" ON "PayrollSalesAttribution"("status");
