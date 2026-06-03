-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "clientName" TEXT,
    "clientPhone" TEXT,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "reason" TEXT,
    "contractNumber" TEXT,
    "refundDate" TIMESTAMP(3),
    "bankRecipientName" TEXT,
    "bankName" TEXT,
    "bankBik" TEXT,
    "bankAccount" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "paidAt" TIMESTAMP(3),
    "documentsJson" TEXT,
    "rawExtractedJson" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Refund_companyId_idx" ON "Refund"("companyId");

-- CreateIndex
CREATE INDEX "Refund_clubId_idx" ON "Refund"("clubId");

-- CreateIndex
CREATE INDEX "Refund_createdByUserId_idx" ON "Refund"("createdByUserId");

-- CreateIndex
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

