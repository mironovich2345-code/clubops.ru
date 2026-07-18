-- Non-destructive: three new tables for the managerial cash contour.
-- No changes to existing tables; existing balances are untouched.

-- CreateTable
CREATE TABLE "CashCollection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "operationDate" TIMESTAMP(3) NOT NULL,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_accountant_review',
    "createdByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashWithdrawal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "fromLegalEntityId" TEXT NOT NULL,
    "toLegalEntityId" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "operationDate" TIMESTAMP(3) NOT NULL,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "createdByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashOperationDocument" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT,
    "withdrawalId" TEXT,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "safeFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedByUserId" TEXT,

    CONSTRAINT "CashOperationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashCollection_companyId_clubId_idx" ON "CashCollection"("companyId", "clubId");
CREATE INDEX "CashCollection_clubId_legalEntityId_status_idx" ON "CashCollection"("clubId", "legalEntityId", "status");
CREATE INDEX "CashCollection_status_idx" ON "CashCollection"("status");
CREATE INDEX "CashCollection_operationDate_idx" ON "CashCollection"("operationDate");

-- CreateIndex
CREATE INDEX "CashWithdrawal_companyId_clubId_idx" ON "CashWithdrawal"("companyId", "clubId");
CREATE INDEX "CashWithdrawal_clubId_status_idx" ON "CashWithdrawal"("clubId", "status");
CREATE INDEX "CashWithdrawal_status_idx" ON "CashWithdrawal"("status");
CREATE INDEX "CashWithdrawal_operationDate_idx" ON "CashWithdrawal"("operationDate");

-- CreateIndex
CREATE UNIQUE INDEX "CashOperationDocument_storageKey_key" ON "CashOperationDocument"("storageKey");
CREATE INDEX "CashOperationDocument_collectionId_idx" ON "CashOperationDocument"("collectionId");
CREATE INDEX "CashOperationDocument_withdrawalId_idx" ON "CashOperationDocument"("withdrawalId");
CREATE INDEX "CashOperationDocument_companyId_clubId_idx" ON "CashOperationDocument"("companyId", "clubId");
