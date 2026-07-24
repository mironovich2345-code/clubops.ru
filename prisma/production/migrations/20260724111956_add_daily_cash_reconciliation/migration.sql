-- Non-destructive additive migration (production PostgreSQL) — daily cash reconciliation.
-- New table only; no ALTER/DROP/rebuild of existing tables.

-- CreateTable
CREATE TABLE "DailyCashReconciliation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "legalEntityType" TEXT NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "ofdCashRevenueKopeks" INTEGER NOT NULL DEFAULT 0,
    "expectedCashBalanceKopeks" INTEGER NOT NULL DEFAULT 0,
    "actualCashBalanceKopeks" INTEGER NOT NULL DEFAULT 0,
    "differenceKopeks" INTEGER NOT NULL DEFAULT 0,
    "reasonCode" TEXT,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'awaiting_input',
    "resolution" TEXT,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedOnTime" BOOLEAN,
    "regionalReviewedById" TEXT,
    "regionalReviewedAt" TIMESTAMP(3),
    "accountingReviewedById" TEXT,
    "accountingReviewedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DailyCashReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyCashReconciliation_companyId_idx" ON "DailyCashReconciliation"("companyId");
CREATE INDEX "DailyCashReconciliation_clubId_idx" ON "DailyCashReconciliation"("clubId");
CREATE INDEX "DailyCashReconciliation_status_idx" ON "DailyCashReconciliation"("status");
CREATE INDEX "DailyCashReconciliation_businessDate_idx" ON "DailyCashReconciliation"("businessDate");
CREATE UNIQUE INDEX "DailyCashReconciliation_clubId_legalEntityId_businessDate_key" ON "DailyCashReconciliation"("clubId", "legalEntityId", "businessDate");
