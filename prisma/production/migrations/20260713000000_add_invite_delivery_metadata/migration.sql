-- AlterTable (additive; all nullable / defaulted → legacy Invite rows unaffected)
ALTER TABLE "Invite" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "Invite" ADD COLUMN "acceptedByUserId" TEXT;
ALTER TABLE "Invite" ADD COLUMN "lastSentAt" TIMESTAMP(3);
ALTER TABLE "Invite" ADD COLUMN "sentCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Invite" ADD COLUMN "emailDeliveryStatus" TEXT;
ALTER TABLE "Invite" ADD COLUMN "sendWindowStartedAt" TIMESTAMP(3);
ALTER TABLE "Invite" ADD COLUMN "sendCountInWindow" INTEGER NOT NULL DEFAULT 0;
