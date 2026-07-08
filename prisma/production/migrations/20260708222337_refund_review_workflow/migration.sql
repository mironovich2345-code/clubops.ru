-- AlterTable (additive; all nullable → legacy rows unaffected)
ALTER TABLE "Refund" ADD COLUMN "regionalReviewRequestedAt" TIMESTAMP(3);
ALTER TABLE "Refund" ADD COLUMN "submittedByManagerId" TEXT;
ALTER TABLE "Refund" ADD COLUMN "regionalReviewedAt" TIMESTAMP(3);
ALTER TABLE "Refund" ADD COLUMN "regionalReviewedByUserId" TEXT;
ALTER TABLE "Refund" ADD COLUMN "regionalCorrectionComment" TEXT;
ALTER TABLE "Refund" ADD COLUMN "accountingStartedAt" TIMESTAMP(3);
