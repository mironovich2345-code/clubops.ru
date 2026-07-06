-- Additive: multi-document attachments for simplified expenses. New table only;
-- no Expense column changed/removed, no data migrated. Legacy single-file fields
-- (originalFileStorageKey…) remain intact.
CREATE TABLE "ExpenseDocument" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedByUserId" TEXT,
    "removalReason" TEXT,

    CONSTRAINT "ExpenseDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExpenseDocument_storageKey_key" ON "ExpenseDocument"("storageKey");
CREATE INDEX "ExpenseDocument_expenseId_idx" ON "ExpenseDocument"("expenseId");
CREATE INDEX "ExpenseDocument_companyId_clubId_idx" ON "ExpenseDocument"("companyId", "clubId");
CREATE INDEX "ExpenseDocument_createdAt_idx" ON "ExpenseDocument"("createdAt");
CREATE INDEX "ExpenseDocument_removedAt_idx" ON "ExpenseDocument"("removedAt");

ALTER TABLE "ExpenseDocument" ADD CONSTRAINT "ExpenseDocument_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
