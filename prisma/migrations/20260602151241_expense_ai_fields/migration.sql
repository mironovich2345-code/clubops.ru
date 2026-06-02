-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Expense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'manual',
    "category" TEXT NOT NULL,
    "vendorName" TEXT,
    "recipientName" TEXT,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "expenseDate" DATETIME NOT NULL,
    "address" TEXT,
    "itemsJson" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "paymentMethod" TEXT,
    "comment" TEXT,
    "notes" TEXT,
    "originalFileName" TEXT,
    "originalFileMime" TEXT,
    "originalFileSize" INTEGER,
    "originalFileStorageKey" TEXT,
    "rawExtractedJson" TEXT,
    "fileUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Expense_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Expense_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Expense_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Expense_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Expense" ("amountKopeks", "category", "clubId", "comment", "companyId", "createdAt", "createdByUserId", "expenseDate", "fileUrl", "id", "legalEntityId", "paymentMethod", "updatedAt", "vendorName") SELECT "amountKopeks", "category", "clubId", "comment", "companyId", "createdAt", "createdByUserId", "expenseDate", "fileUrl", "id", "legalEntityId", "paymentMethod", "updatedAt", "vendorName" FROM "Expense";
DROP TABLE "Expense";
ALTER TABLE "new_Expense" RENAME TO "Expense";
CREATE INDEX "Expense_companyId_idx" ON "Expense"("companyId");
CREATE INDEX "Expense_clubId_idx" ON "Expense"("clubId");
CREATE INDEX "Expense_createdByUserId_idx" ON "Expense"("createdByUserId");
CREATE INDEX "Expense_category_idx" ON "Expense"("category");
CREATE INDEX "Expense_expenseDate_idx" ON "Expense"("expenseDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
