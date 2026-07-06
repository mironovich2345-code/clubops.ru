-- CreateTable
CREATE TABLE "ExpenseDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expenseId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "safeFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "documentType" TEXT NOT NULL DEFAULT 'receipt',
    "uploadedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" DATETIME,
    "removedByUserId" TEXT,
    "removalReason" TEXT,
    CONSTRAINT "ExpenseDocument_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseDocument_storageKey_key" ON "ExpenseDocument"("storageKey");

-- CreateIndex
CREATE INDEX "ExpenseDocument_expenseId_idx" ON "ExpenseDocument"("expenseId");

-- CreateIndex
CREATE INDEX "ExpenseDocument_companyId_clubId_idx" ON "ExpenseDocument"("companyId", "clubId");

-- CreateIndex
CREATE INDEX "ExpenseDocument_createdAt_idx" ON "ExpenseDocument"("createdAt");

-- CreateIndex
CREATE INDEX "ExpenseDocument_removedAt_idx" ON "ExpenseDocument"("removedAt");
