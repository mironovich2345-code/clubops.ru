-- AlterTable
ALTER TABLE "Refund" ADD COLUMN "accountingStartedAt" DATETIME;
ALTER TABLE "Refund" ADD COLUMN "regionalCorrectionComment" TEXT;
ALTER TABLE "Refund" ADD COLUMN "regionalReviewRequestedAt" DATETIME;
ALTER TABLE "Refund" ADD COLUMN "regionalReviewedAt" DATETIME;
ALTER TABLE "Refund" ADD COLUMN "regionalReviewedByUserId" TEXT;
ALTER TABLE "Refund" ADD COLUMN "submittedByManagerId" TEXT;
