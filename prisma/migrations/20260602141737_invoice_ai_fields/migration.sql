-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "counterpartyName" TEXT,
    "counterpartyInn" TEXT,
    "counterpartyKpp" TEXT,
    "counterpartyBankName" TEXT,
    "counterpartyBankBik" TEXT,
    "counterpartyAccount" TEXT,
    "counterpartyCorrAccount" TEXT,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "expenseCategory" TEXT,
    "subject" TEXT,
    "invoiceNumber" TEXT,
    "invoiceDate" DATETIME,
    "dueDate" DATETIME,
    "paidAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "originalFileName" TEXT,
    "originalFileMime" TEXT,
    "originalFileSize" INTEGER,
    "originalFileStorageKey" TEXT,
    "rawExtractedJson" TEXT,
    "notes" TEXT,
    "comment" TEXT,
    "fileUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invoice_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invoice_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Invoice_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Invoice" ("amountKopeks", "clubId", "comment", "companyId", "counterpartyName", "createdAt", "createdByUserId", "dueDate", "fileUrl", "id", "invoiceDate", "legalEntityId", "paidAt", "status", "subject", "updatedAt") SELECT "amountKopeks", "clubId", "comment", "companyId", "counterpartyName", "createdAt", "createdByUserId", "dueDate", "fileUrl", "id", "invoiceDate", "legalEntityId", "paidAt", "status", "subject", "updatedAt" FROM "Invoice";
DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";
CREATE INDEX "Invoice_companyId_idx" ON "Invoice"("companyId");
CREATE INDEX "Invoice_clubId_idx" ON "Invoice"("clubId");
CREATE INDEX "Invoice_createdByUserId_idx" ON "Invoice"("createdByUserId");
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice"("dueDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
