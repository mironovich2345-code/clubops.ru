-- Additive session activity + revocation metadata. Existing sessions stay valid:
-- lastSeenAt defaults to now(), revokedAt is NULL (= active). No data removed.
ALTER TABLE "Session" ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Session" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "revokedReason" TEXT;
ALTER TABLE "Session" ADD COLUMN "revokedByUserId" TEXT;
ALTER TABLE "Session" ADD COLUMN "userAgent" TEXT;
ALTER TABLE "Session" ADD COLUMN "deviceLabel" TEXT;

CREATE INDEX "Session_revokedAt_idx" ON "Session"("revokedAt");
