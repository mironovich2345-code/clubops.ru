-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "SalesReport" ADD COLUMN     "importBatchId" TEXT;

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT,
    "type" TEXT NOT NULL,
    "fileName" TEXT,
    "fileHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revertedByUserId" TEXT,
    "revertedAt" TIMESTAMP(3),
    "rowsCreated" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
    "rowsDuplicated" INTEGER NOT NULL DEFAULT 0,
    "rowsErrored" INTEGER NOT NULL DEFAULT 0,
    "summaryJson" TEXT,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_companyId_idx" ON "ImportBatch"("companyId");

-- CreateIndex
CREATE INDEX "ImportBatch_type_idx" ON "ImportBatch"("type");

-- CreateIndex
CREATE INDEX "ImportBatch_fileHash_idx" ON "ImportBatch"("fileHash");

-- CreateIndex
CREATE INDEX "ImportBatch_createdByUserId_idx" ON "ImportBatch"("createdByUserId");

-- CreateIndex
CREATE INDEX "Invoice_importBatchId_idx" ON "Invoice"("importBatchId");

-- CreateIndex
CREATE INDEX "Expense_importBatchId_idx" ON "Expense"("importBatchId");

-- CreateIndex
CREATE INDEX "SalesReport_importBatchId_idx" ON "SalesReport"("importBatchId");

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

