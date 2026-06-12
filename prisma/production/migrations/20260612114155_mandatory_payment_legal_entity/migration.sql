-- AlterTable
ALTER TABLE "MandatoryPaymentPlan" ADD COLUMN     "legalEntityId" TEXT;

-- AddForeignKey
ALTER TABLE "MandatoryPaymentPlan" ADD CONSTRAINT "MandatoryPaymentPlan_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

