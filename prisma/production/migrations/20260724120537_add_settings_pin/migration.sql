-- Non-destructive additive migration (production PostgreSQL) — settings PIN.
-- Company gets 6 in-place nullable/defaulted columns (NO table rebuild). New
-- SettingsPinSession table. No DROP/rebuild of existing tables.

-- AlterTable (in place)
ALTER TABLE "Company" ADD COLUMN "primaryOwnerUserId" TEXT;
ALTER TABLE "Company" ADD COLUMN "settingsPinHash" TEXT;
ALTER TABLE "Company" ADD COLUMN "settingsPinSetAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "settingsPinSetByUserId" TEXT;
ALTER TABLE "Company" ADD COLUMN "settingsPinFailedAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Company" ADD COLUMN "settingsPinLockedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SettingsPinSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SettingsPinSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SettingsPinSession_tokenHash_key" ON "SettingsPinSession"("tokenHash");
CREATE INDEX "SettingsPinSession_userId_companyId_idx" ON "SettingsPinSession"("userId", "companyId");
CREATE INDEX "SettingsPinSession_expiresAt_idx" ON "SettingsPinSession"("expiresAt");

-- Backfill primaryOwnerUserId: the earliest 'owner' access row per company (explicit
-- rule — NOT the oldest user). Nullable if a company has no owner grant.
UPDATE "Company" SET "primaryOwnerUserId" = (
    SELECT "userId" FROM "CompanyUserAccess"
    WHERE "CompanyUserAccess"."companyId" = "Company"."id" AND "CompanyUserAccess"."role" = 'owner'
    ORDER BY "createdAt" ASC LIMIT 1
) WHERE "primaryOwnerUserId" IS NULL;
