-- Non-destructive: three nullable columns on Invoice recording the accountant/owner
-- manual review of the AI-extracted fields. No data changes, no drops. Existing rows
-- keep NULL (never reviewed) and behave exactly as before.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "aiDataReviewedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN     "aiDataReviewedById" TEXT;
ALTER TABLE "Invoice" ADD COLUMN     "aiDataReviewNote" TEXT;
