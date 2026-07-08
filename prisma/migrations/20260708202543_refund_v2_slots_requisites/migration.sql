-- CreateTable
CREATE TABLE "RefundDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "refundId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "safeFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "activeSlotKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" DATETIME,
    "removedByUserId" TEXT,
    "removalReason" TEXT,
    CONSTRAINT "RefundDocument_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Refund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "clientName" TEXT,
    "clientPhone" TEXT,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "reason" TEXT,
    "contractNumber" TEXT,
    "refundDate" DATETIME,
    "bankRecipientName" TEXT,
    "bankName" TEXT,
    "bankBik" TEXT,
    "bankAccount" TEXT,
    "bankCorrAccount" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "paidAt" DATETIME,
    "returnType" TEXT,
    "entryVersion" INTEGER NOT NULL DEFAULT 1,
    "documentsJson" TEXT,
    "rawExtractedJson" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Refund_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Refund_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Refund_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Refund" ("amountKopeks", "bankAccount", "bankBik", "bankName", "bankRecipientName", "clientName", "clientPhone", "clubId", "companyId", "confidence", "contractNumber", "createdAt", "createdByUserId", "currency", "documentsJson", "id", "notes", "paidAt", "rawExtractedJson", "reason", "refundDate", "status", "updatedAt") SELECT "amountKopeks", "bankAccount", "bankBik", "bankName", "bankRecipientName", "clientName", "clientPhone", "clubId", "companyId", "confidence", "contractNumber", "createdAt", "createdByUserId", "currency", "documentsJson", "id", "notes", "paidAt", "rawExtractedJson", "reason", "refundDate", "status", "updatedAt" FROM "Refund";
DROP TABLE "Refund";
ALTER TABLE "new_Refund" RENAME TO "Refund";
CREATE INDEX "Refund_companyId_idx" ON "Refund"("companyId");
CREATE INDEX "Refund_clubId_idx" ON "Refund"("clubId");
CREATE INDEX "Refund_createdByUserId_idx" ON "Refund"("createdByUserId");
CREATE INDEX "Refund_status_idx" ON "Refund"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "RefundDocument_storageKey_key" ON "RefundDocument"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "RefundDocument_activeSlotKey_key" ON "RefundDocument"("activeSlotKey");

-- CreateIndex
CREATE INDEX "RefundDocument_refundId_idx" ON "RefundDocument"("refundId");

-- CreateIndex
CREATE INDEX "RefundDocument_companyId_clubId_idx" ON "RefundDocument"("companyId", "clubId");

-- CreateIndex
CREATE INDEX "RefundDocument_removedAt_idx" ON "RefundDocument"("removedAt");
