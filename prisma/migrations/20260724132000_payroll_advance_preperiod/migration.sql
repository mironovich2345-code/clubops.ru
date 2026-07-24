-- AlterTable (additive, in-place; scalar-id table)
ALTER TABLE "PayrollAdvance" ADD COLUMN "legalEntityId" TEXT;
ALTER TABLE "PayrollAdvance" ADD COLUMN "source" TEXT;
ALTER TABLE "PayrollAdvance" ADD COLUMN "earnedToDateSource" TEXT;
ALTER TABLE "PayrollAdvance" ADD COLUMN "comment" TEXT;
