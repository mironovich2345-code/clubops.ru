-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedByUserId" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending_accountant',
ADD COLUMN     "submittedByUserId" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedByUserId" TEXT;

-- CreateIndex
CREATE INDEX "Sale_status_idx" ON "Sale"("status");


-- Backfill: sales created before the verification workflow are treated as confirmed revenue.
UPDATE "Sale" SET "status" = 'confirmed' WHERE "status" = 'pending_accountant';
