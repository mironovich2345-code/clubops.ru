-- AlterTable (additive; all nullable → legacy rows unaffected)
ALTER TABLE "Invoice" ADD COLUMN "correctionComment" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "correctionRequestedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "correctionRequestedByUserId" TEXT;
