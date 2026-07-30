-- CreateTable
CREATE TABLE "CashRegionalTransfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "operationDate" DATETIME NOT NULL,
    "recipientRegionalDirectorId" TEXT NOT NULL,
    "recipientNameSnapshot" TEXT NOT NULL,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_confirmation',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" DATETIME,
    "cancelledById" TEXT,
    "cancelledAt" DATETIME,
    "cancellationReason" TEXT,
    "idempotencyKey" TEXT NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BalanceSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "snapshotDate" DATETIME NOT NULL,
    "actualBalanceKopeks" INTEGER NOT NULL,
    "comment" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesSnapshotId" TEXT,
    "correctionReason" TEXT,
    CONSTRAINT "BalanceSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BalanceSnapshot_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BalanceSnapshot_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BalanceSnapshot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_BalanceSnapshot" ("actualBalanceKopeks", "clubId", "comment", "companyId", "createdAt", "createdById", "id", "legalEntityId", "snapshotDate", "updatedAt") SELECT "actualBalanceKopeks", "clubId", "comment", "companyId", "createdAt", "createdById", "id", "legalEntityId", "snapshotDate", "updatedAt" FROM "BalanceSnapshot";
DROP TABLE "BalanceSnapshot";
ALTER TABLE "new_BalanceSnapshot" RENAME TO "BalanceSnapshot";
CREATE INDEX "BalanceSnapshot_companyId_idx" ON "BalanceSnapshot"("companyId");
CREATE INDEX "BalanceSnapshot_clubId_idx" ON "BalanceSnapshot"("clubId");
CREATE INDEX "BalanceSnapshot_legalEntityId_idx" ON "BalanceSnapshot"("legalEntityId");
CREATE INDEX "BalanceSnapshot_clubId_legalEntityId_snapshotDate_idx" ON "BalanceSnapshot"("clubId", "legalEntityId", "snapshotDate");
CREATE INDEX "BalanceSnapshot_clubId_legalEntityId_status_snapshotDate_idx" ON "BalanceSnapshot"("clubId", "legalEntityId", "status", "snapshotDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CashRegionalTransfer_idempotencyKey_key" ON "CashRegionalTransfer"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CashRegionalTransfer_companyId_clubId_idx" ON "CashRegionalTransfer"("companyId", "clubId");

-- CreateIndex
CREATE INDEX "CashRegionalTransfer_clubId_legalEntityId_status_idx" ON "CashRegionalTransfer"("clubId", "legalEntityId", "status");

-- CreateIndex
CREATE INDEX "CashRegionalTransfer_status_idx" ON "CashRegionalTransfer"("status");

-- CreateIndex
CREATE INDEX "CashRegionalTransfer_operationDate_idx" ON "CashRegionalTransfer"("operationDate");

-- CreateIndex
CREATE INDEX "CashRegionalTransfer_recipientRegionalDirectorId_idx" ON "CashRegionalTransfer"("recipientRegionalDirectorId");

-- CreateIndex
CREATE INDEX "OfdReceiptImport_operatorNormalized_idx" ON "OfdReceiptImport"("operatorNormalized");

