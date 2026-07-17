-- CreateTable
CREATE TABLE "OfdReceiptItem" (
    "id" TEXT NOT NULL,
    "receiptImportId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'taxcom',
    "date" TEXT NOT NULL,
    "fnNumber" TEXT NOT NULL,
    "fdNumber" INTEGER NOT NULL,
    "fiscalSign" TEXT,
    "lineIndex" INTEGER NOT NULL,
    "itemName" TEXT NOT NULL,
    "normalizedItemName" TEXT NOT NULL,
    "quantityMilli" INTEGER NOT NULL DEFAULT 1000,
    "priceKopeks" INTEGER NOT NULL DEFAULT 0,
    "totalKopeks" INTEGER NOT NULL DEFAULT 0,
    "operationType" TEXT NOT NULL,
    "revenueCategoryCode" TEXT NOT NULL,
    "revenueCategoryName" TEXT NOT NULL,
    "categoryRuleId" TEXT,
    "itemKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfdReceiptItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfdRevenueCategoryRule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "categoryCode" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "normalizedPattern" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfdRevenueCategoryRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfdRevenueCategoryDailySummary" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'taxcom',
    "date" TEXT NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "incomeTotalKopeks" INTEGER NOT NULL DEFAULT 0,
    "returnTotalKopeks" INTEGER NOT NULL DEFAULT 0,
    "netTotalKopeks" INTEGER NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "receiptCount" INTEGER NOT NULL DEFAULT 0,
    "summaryKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfdRevenueCategoryDailySummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfdReceiptItem_itemKey_key" ON "OfdReceiptItem"("itemKey");

-- CreateIndex
CREATE INDEX "OfdReceiptItem_companyId_clubId_idx" ON "OfdReceiptItem"("companyId", "clubId");

-- CreateIndex
CREATE INDEX "OfdReceiptItem_receiptImportId_idx" ON "OfdReceiptItem"("receiptImportId");

-- CreateIndex
CREATE INDEX "OfdReceiptItem_date_idx" ON "OfdReceiptItem"("date");

-- CreateIndex
CREATE INDEX "OfdReceiptItem_revenueCategoryCode_idx" ON "OfdReceiptItem"("revenueCategoryCode");

-- CreateIndex
CREATE INDEX "OfdRevenueCategoryRule_companyId_idx" ON "OfdRevenueCategoryRule"("companyId");

-- CreateIndex
CREATE INDEX "OfdRevenueCategoryRule_companyId_legalEntityId_idx" ON "OfdRevenueCategoryRule"("companyId", "legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "OfdRevenueCategoryDailySummary_summaryKey_key" ON "OfdRevenueCategoryDailySummary"("summaryKey");

-- CreateIndex
CREATE INDEX "OfdRevenueCategoryDailySummary_companyId_clubId_idx" ON "OfdRevenueCategoryDailySummary"("companyId", "clubId");

-- CreateIndex
CREATE INDEX "OfdRevenueCategoryDailySummary_date_idx" ON "OfdRevenueCategoryDailySummary"("date");

-- CreateIndex
CREATE INDEX "OfdRevenueCategoryDailySummary_categoryCode_idx" ON "OfdRevenueCategoryDailySummary"("categoryCode");
