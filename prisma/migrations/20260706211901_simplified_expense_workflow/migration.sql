-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ExpenseCategoryNameHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "changedByUserId" TEXT,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExpenseCategoryNameHistory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
    "transferComment" TEXT,
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
    "importBatchId" TEXT,
    "entryVersion" INTEGER NOT NULL DEFAULT 1,
    "shoppingListText" TEXT,
    "generatedTitle" TEXT,
    "paidByUserId" TEXT,
    "aiCheckStatus" TEXT,
    "aiCheckSummary" TEXT,
    "submittedAt" DATETIME,
    "verifiedAt" DATETIME,
    "verifiedByUserId" TEXT,
    "correctionRequestedAt" DATETIME,
    "correctionRequestedByUserId" TEXT,
    "correctionReason" TEXT,
    "cancelledAt" DATETIME,
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "firstSavedAt" DATETIME,
    "budgetOverrunKopeks" INTEGER,
    "budgetOverrunBasisPoints" INTEGER,
    "budgetApprovalLevel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Expense_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Expense_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Expense_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Expense_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Expense_paidByUserId_fkey" FOREIGN KEY ("paidByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Expense" ("address", "amountKopeks", "category", "clubId", "comment", "companyId", "confidence", "createdAt", "createdByUserId", "currency", "expenseDate", "fileUrl", "id", "importBatchId", "itemsJson", "legalEntityId", "notes", "originalFileMime", "originalFileName", "originalFileSize", "originalFileStorageKey", "paymentMethod", "rawExtractedJson", "recipientName", "status", "transferComment", "type", "updatedAt", "vendorName") SELECT "address", "amountKopeks", "category", "clubId", "comment", "companyId", "confidence", "createdAt", "createdByUserId", "currency", "expenseDate", "fileUrl", "id", "importBatchId", "itemsJson", "legalEntityId", "notes", "originalFileMime", "originalFileName", "originalFileSize", "originalFileStorageKey", "paymentMethod", "rawExtractedJson", "recipientName", "status", "transferComment", "type", "updatedAt", "vendorName" FROM "Expense";
DROP TABLE "Expense";
ALTER TABLE "new_Expense" RENAME TO "Expense";
CREATE INDEX "Expense_companyId_idx" ON "Expense"("companyId");
CREATE INDEX "Expense_clubId_idx" ON "Expense"("clubId");
CREATE INDEX "Expense_createdByUserId_idx" ON "Expense"("createdByUserId");
CREATE INDEX "Expense_category_idx" ON "Expense"("category");
CREATE INDEX "Expense_expenseDate_idx" ON "Expense"("expenseDate");
CREATE INDEX "Expense_importBatchId_idx" ON "Expense"("importBatchId");
CREATE INDEX "Expense_status_idx" ON "Expense"("status");
CREATE INDEX "Expense_entryVersion_idx" ON "Expense"("entryVersion");
CREATE INDEX "Expense_paidByUserId_idx" ON "Expense"("paidByUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_key_key" ON "ExpenseCategory"("key");

-- CreateIndex
CREATE INDEX "ExpenseCategory_isActive_idx" ON "ExpenseCategory"("isActive");

-- CreateIndex
CREATE INDEX "ExpenseCategoryNameHistory_categoryId_idx" ON "ExpenseCategoryNameHistory"("categoryId");
