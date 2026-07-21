-- Non-destructive additive migration (production PostgreSQL).
-- (1) ExpenseCategory ownership scope: isSystem + nullable companyId. `key` stays
--     globally unique. Existing canonical (code-defined) categories are marked
--     SYSTEM; any non-canonical legacy rows keep isSystem=false + companyId=null
--     (safe read-only legacy — historical Expense labels via key are unaffected,
--     but no company can select or mutate them; their origin is NOT guessed).
-- (2) RateLimitBucket table.
-- Only ADD COLUMN / CREATE INDEX / CREATE TABLE / an idempotent data UPDATE.
-- No DROP / TRUNCATE / DELETE, no table rebuild.

ALTER TABLE "ExpenseCategory" ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ExpenseCategory" ADD COLUMN "companyId" TEXT;

-- Mark the code-defined canonical taxonomy as SYSTEM (companyId stays NULL).
UPDATE "ExpenseCategory" SET "isSystem" = true
WHERE "key" IN (
  'advertising','household','builders','rent','maintenance','investments','taxes',
  'salary','dismissal_compensation','recruitment','it_services','office_supplies',
  'consumables','refunds','other'
);

CREATE INDEX "ExpenseCategory_companyId_idx" ON "ExpenseCategory"("companyId");

CREATE TABLE "RateLimitBucket" (
  "id" TEXT NOT NULL,
  "bucketKey" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RateLimitBucket_bucketKey_key" ON "RateLimitBucket"("bucketKey");
CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");
CREATE INDEX "RateLimitBucket_action_idx" ON "RateLimitBucket"("action");
