-- CreateTable (new table; no existing rows affected)
CREATE TABLE "PendingInvoiceUpload" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'invoice',
    "originalFileName" TEXT,
    "originalFileMime" TEXT,
    "originalFileSize" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingInvoiceUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingInvoiceUpload_storageKey_key" ON "PendingInvoiceUpload"("storageKey");

-- CreateIndex
CREATE INDEX "PendingInvoiceUpload_uploadedByUserId_idx" ON "PendingInvoiceUpload"("uploadedByUserId");

-- CreateIndex
CREATE INDEX "PendingInvoiceUpload_expiresAt_idx" ON "PendingInvoiceUpload"("expiresAt");
