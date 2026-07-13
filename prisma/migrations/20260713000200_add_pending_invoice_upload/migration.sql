-- CreateTable (new table; no existing rows affected)
CREATE TABLE "PendingInvoiceUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storageKey" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'invoice',
    "originalFileName" TEXT,
    "originalFileMime" TEXT,
    "originalFileSize" INTEGER,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingInvoiceUpload_storageKey_key" ON "PendingInvoiceUpload"("storageKey");

-- CreateIndex
CREATE INDEX "PendingInvoiceUpload_uploadedByUserId_idx" ON "PendingInvoiceUpload"("uploadedByUserId");

-- CreateIndex
CREATE INDEX "PendingInvoiceUpload_expiresAt_idx" ON "PendingInvoiceUpload"("expiresAt");
