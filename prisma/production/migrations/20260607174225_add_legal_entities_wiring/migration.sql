-- AlterTable
ALTER TABLE "LegalEntity" ADD COLUMN     "bankBik" TEXT,
ADD COLUMN     "corrAccount" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "kpp" TEXT;

-- AlterTable
ALTER TABLE "ClubLegalEntity" ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "SalesReportLine" ADD COLUMN     "legalEntityId" TEXT;

-- AlterTable
ALTER TABLE "SalesReportDocument" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'other';

-- CreateIndex
CREATE INDEX "SalesReportLine_legalEntityId_idx" ON "SalesReportLine"("legalEntityId");

-- AddForeignKey
ALTER TABLE "SalesReportLine" ADD CONSTRAINT "SalesReportLine_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

