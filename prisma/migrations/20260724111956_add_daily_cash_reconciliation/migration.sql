-- CreateTable
CREATE TABLE "DailyCashReconciliation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "legalEntityType" TEXT NOT NULL,
    "businessDate" DATETIME NOT NULL,
    "ofdCashRevenueKopeks" INTEGER NOT NULL DEFAULT 0,
    "expectedCashBalanceKopeks" INTEGER NOT NULL DEFAULT 0,
    "actualCashBalanceKopeks" INTEGER NOT NULL DEFAULT 0,
    "differenceKopeks" INTEGER NOT NULL DEFAULT 0,
    "reasonCode" TEXT,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'awaiting_input',
    "resolution" TEXT,
    "submittedById" TEXT,
    "submittedAt" DATETIME,
    "submittedOnTime" BOOLEAN,
    "regionalReviewedById" TEXT,
    "regionalReviewedAt" DATETIME,
    "accountingReviewedById" TEXT,
    "accountingReviewedAt" DATETIME,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "DailyCashReconciliation_companyId_idx" ON "DailyCashReconciliation"("companyId");

-- CreateIndex
CREATE INDEX "DailyCashReconciliation_clubId_idx" ON "DailyCashReconciliation"("clubId");

-- CreateIndex
CREATE INDEX "DailyCashReconciliation_status_idx" ON "DailyCashReconciliation"("status");

-- CreateIndex
CREATE INDEX "DailyCashReconciliation_businessDate_idx" ON "DailyCashReconciliation"("businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailyCashReconciliation_clubId_legalEntityId_businessDate_key" ON "DailyCashReconciliation"("clubId", "legalEntityId", "businessDate");
