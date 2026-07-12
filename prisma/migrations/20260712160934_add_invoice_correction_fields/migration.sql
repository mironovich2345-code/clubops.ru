-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "correctionComment" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "correctionRequestedAt" DATETIME;
ALTER TABLE "Invoice" ADD COLUMN "correctionRequestedByUserId" TEXT;
