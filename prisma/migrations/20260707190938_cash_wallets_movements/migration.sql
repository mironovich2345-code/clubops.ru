-- AlterTable
ALTER TABLE "Expense" ADD COLUMN "cashWalletId" TEXT;

-- CreateTable
CREATE TABLE "CashWallet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "holderUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CashWallet_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CashWallet_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CashWallet_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "fromWalletId" TEXT,
    "toWalletId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "occurredAt" DATETIME NOT NULL,
    "createdByUserId" TEXT,
    "confirmedByUserId" TEXT,
    "confirmedAt" DATETIME,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CashMovement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CashMovement_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CashMovement_fromWalletId_fkey" FOREIGN KEY ("fromWalletId") REFERENCES "CashWallet" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CashMovement_toWalletId_fkey" FOREIGN KEY ("toWalletId") REFERENCES "CashWallet" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CashWallet_companyId_idx" ON "CashWallet"("companyId");

-- CreateIndex
CREATE INDEX "CashWallet_clubId_legalEntityId_idx" ON "CashWallet"("clubId", "legalEntityId");

-- CreateIndex
CREATE INDEX "CashWallet_holderUserId_idx" ON "CashWallet"("holderUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CashWallet_clubId_legalEntityId_type_holderUserId_key" ON "CashWallet"("clubId", "legalEntityId", "type", "holderUserId");

-- CreateIndex
CREATE INDEX "CashMovement_clubId_legalEntityId_status_idx" ON "CashMovement"("clubId", "legalEntityId", "status");

-- CreateIndex
CREATE INDEX "CashMovement_toWalletId_status_idx" ON "CashMovement"("toWalletId", "status");

-- CreateIndex
CREATE INDEX "CashMovement_fromWalletId_status_idx" ON "CashMovement"("fromWalletId", "status");

-- CreateIndex
CREATE INDEX "CashMovement_type_idx" ON "CashMovement"("type");

-- CreateIndex
CREATE INDEX "CashMovement_occurredAt_idx" ON "CashMovement"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CashMovement_sourceType_sourceId_key" ON "CashMovement"("sourceType", "sourceId");
