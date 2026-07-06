-- AlterTable
ALTER TABLE "User" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "deletionRequestedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "recoveryPurgedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "restoreUntil" DATETIME;
ALTER TABLE "User" ADD COLUMN "systemRole" TEXT;

-- CreateTable
CREATE TABLE "AccountDeletion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "requestedByUserId" TEXT,
    "requestType" TEXT NOT NULL,
    "originalEmailEncrypted" TEXT,
    "originalEmailHash" TEXT NOT NULL,
    "originalEmailMasked" TEXT NOT NULL,
    "restoreTokenHash" TEXT,
    "restoreUntil" DATETIME NOT NULL,
    "confirmedAt" DATETIME,
    "deletedAt" DATETIME,
    "restoredAt" DATETIME,
    "recoveryPurgedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccountDeletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletion_restoreTokenHash_key" ON "AccountDeletion"("restoreTokenHash");

-- CreateIndex
CREATE INDEX "AccountDeletion_userId_idx" ON "AccountDeletion"("userId");

-- CreateIndex
CREATE INDEX "AccountDeletion_originalEmailHash_idx" ON "AccountDeletion"("originalEmailHash");

-- CreateIndex
CREATE INDEX "AccountDeletion_restoreUntil_idx" ON "AccountDeletion"("restoreUntil");

-- CreateIndex
CREATE INDEX "AccountDeletion_deletedAt_idx" ON "AccountDeletion"("deletedAt");
