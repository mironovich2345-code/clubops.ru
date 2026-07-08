-- AlterTable (additive; existing rows keep NULL / default 1)
ALTER TABLE "Refund" ADD COLUMN "bankCorrAccount" TEXT;
ALTER TABLE "Refund" ADD COLUMN "returnType" TEXT;
ALTER TABLE "Refund" ADD COLUMN "entryVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "RefundDocument" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedByUserId" TEXT,
    "removalReason" TEXT,

    CONSTRAINT "RefundDocument_pkey" PRIMARY KEY ("id")
);

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

-- AddForeignKey
ALTER TABLE "RefundDocument" ADD CONSTRAINT "RefundDocument_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
