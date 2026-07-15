-- CreateTable (new tables; no existing rows affected)
CREATE TABLE "OfdConnection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'taxcom',
    "displayName" TEXT NOT NULL,
    "serverBaseUrl" TEXT NOT NULL,
    "contractNumber" TEXT,
    "authType" TEXT NOT NULL,
    "loginEncrypted" TEXT,
    "passwordEncrypted" TEXT,
    "integrationTokenEncrypted" TEXT,
    "integratorIdEncrypted" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfdConnection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OfdConnection_companyId_idx" ON "OfdConnection"("companyId");
CREATE INDEX "OfdConnection_legalEntityId_idx" ON "OfdConnection"("legalEntityId");
CREATE INDEX "OfdConnection_provider_idx" ON "OfdConnection"("provider");

CREATE TABLE "OfdCashRegisterMapping" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'taxcom',
    "fnNumber" TEXT NOT NULL,
    "kktRegNumber" TEXT,
    "kktFactoryNumber" TEXT,
    "kktName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "activeMappingKey" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfdCashRegisterMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OfdCashRegisterMapping_activeMappingKey_key" ON "OfdCashRegisterMapping"("activeMappingKey");
CREATE INDEX "OfdCashRegisterMapping_connectionId_idx" ON "OfdCashRegisterMapping"("connectionId");
CREATE INDEX "OfdCashRegisterMapping_companyId_clubId_idx" ON "OfdCashRegisterMapping"("companyId", "clubId");
CREATE INDEX "OfdCashRegisterMapping_provider_fnNumber_idx" ON "OfdCashRegisterMapping"("provider", "fnNumber");

CREATE TABLE "OfdReceiptImport" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'taxcom',
    "fnNumber" TEXT NOT NULL,
    "shiftNumber" INTEGER,
    "fiscalDocumentNumber" INTEGER NOT NULL,
    "fiscalSign" TEXT,
    "operationType" TEXT NOT NULL,
    "receiptDate" TIMESTAMP(3) NOT NULL,
    "totalKopeks" INTEGER NOT NULL,
    "cashKopeks" INTEGER NOT NULL,
    "electronicKopeks" INTEGER NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'taxcom',
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfdReceiptImport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OfdReceiptImport_dedupeKey_key" ON "OfdReceiptImport"("dedupeKey");
CREATE INDEX "OfdReceiptImport_companyId_clubId_idx" ON "OfdReceiptImport"("companyId", "clubId");
CREATE INDEX "OfdReceiptImport_fnNumber_idx" ON "OfdReceiptImport"("fnNumber");
CREATE INDEX "OfdReceiptImport_receiptDate_idx" ON "OfdReceiptImport"("receiptDate");
CREATE INDEX "OfdReceiptImport_syncRunId_idx" ON "OfdReceiptImport"("syncRunId");

CREATE TABLE "OfdDailySalesSummary" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'taxcom',
    "date" TEXT NOT NULL,
    "summaryKey" TEXT NOT NULL,
    "incomeTotalKopeks" INTEGER NOT NULL DEFAULT 0,
    "incomeCashKopeks" INTEGER NOT NULL DEFAULT 0,
    "incomeElectronicKopeks" INTEGER NOT NULL DEFAULT 0,
    "returnTotalKopeks" INTEGER NOT NULL DEFAULT 0,
    "returnCashKopeks" INTEGER NOT NULL DEFAULT 0,
    "returnElectronicKopeks" INTEGER NOT NULL DEFAULT 0,
    "netTotalKopeks" INTEGER NOT NULL DEFAULT 0,
    "receiptCount" INTEGER NOT NULL DEFAULT 0,
    "returnReceiptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfdDailySalesSummary_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OfdDailySalesSummary_summaryKey_key" ON "OfdDailySalesSummary"("summaryKey");
CREATE INDEX "OfdDailySalesSummary_companyId_clubId_idx" ON "OfdDailySalesSummary"("companyId", "clubId");
CREATE INDEX "OfdDailySalesSummary_date_idx" ON "OfdDailySalesSummary"("date");

CREATE TABLE "OfdSyncRun" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "mode" TEXT NOT NULL,
    "dateFrom" TEXT NOT NULL,
    "dateTo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedByUserId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "foundReceipts" INTEGER NOT NULL DEFAULT 0,
    "importedReceipts" INTEGER NOT NULL DEFAULT 0,
    "skippedReceipts" INTEGER NOT NULL DEFAULT 0,
    "totalIncomeKopeks" INTEGER NOT NULL DEFAULT 0,
    "totalReturnKopeks" INTEGER NOT NULL DEFAULT 0,
    "safeErrorCode" TEXT,
    "safeErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfdSyncRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OfdSyncRun_connectionId_idx" ON "OfdSyncRun"("connectionId");
CREATE INDEX "OfdSyncRun_companyId_idx" ON "OfdSyncRun"("companyId");
CREATE INDEX "OfdSyncRun_createdAt_idx" ON "OfdSyncRun"("createdAt");

CREATE TABLE "OfdSyncError" (
    "id" TEXT NOT NULL,
    "syncRunId" TEXT NOT NULL,
    "connectionId" TEXT,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT,
    "fnNumber" TEXT,
    "stage" TEXT NOT NULL,
    "safeCode" TEXT NOT NULL,
    "safeMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfdSyncError_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OfdSyncError_syncRunId_idx" ON "OfdSyncError"("syncRunId");
CREATE INDEX "OfdSyncError_companyId_idx" ON "OfdSyncError"("companyId");
