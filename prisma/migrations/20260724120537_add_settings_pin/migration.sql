-- CreateTable
CREATE TABLE "SettingsPinSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "inn" TEXT,
    "kpp" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "primaryOwnerUserId" TEXT,
    "settingsPinHash" TEXT,
    "settingsPinSetAt" DATETIME,
    "settingsPinSetByUserId" TEXT,
    "settingsPinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
    "settingsPinLockedUntil" DATETIME
);
INSERT INTO "new_Company" ("createdAt", "id", "inn", "kpp", "name", "updatedAt") SELECT "createdAt", "id", "inn", "kpp", "name", "updatedAt" FROM "Company";
DROP TABLE "Company";
ALTER TABLE "new_Company" RENAME TO "Company";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SettingsPinSession_tokenHash_key" ON "SettingsPinSession"("tokenHash");

-- CreateIndex
CREATE INDEX "SettingsPinSession_userId_companyId_idx" ON "SettingsPinSession"("userId", "companyId");

-- CreateIndex
CREATE INDEX "SettingsPinSession_expiresAt_idx" ON "SettingsPinSession"("expiresAt");

-- Backfill primaryOwnerUserId for existing companies: the earliest 'owner' access row
-- (explicit rule — NOT the oldest user). Nullable if a company has no owner grant.
UPDATE "Company" SET "primaryOwnerUserId" = (
    SELECT "userId" FROM "CompanyUserAccess"
    WHERE "CompanyUserAccess"."companyId" = "Company"."id" AND "CompanyUserAccess"."role" = 'owner'
    ORDER BY "createdAt" ASC LIMIT 1
) WHERE "primaryOwnerUserId" IS NULL;
