-- Additive: global system role + account soft-deletion lifecycle + recovery
-- record. No User rows removed; existing users/roles/sessions unaffected.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "systemRole" TEXT;
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "restoreUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "recoveryPurgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AccountDeletion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestedByUserId" TEXT,
    "requestType" TEXT NOT NULL,
    "originalEmailEncrypted" TEXT,
    "originalEmailHash" TEXT NOT NULL,
    "originalEmailMasked" TEXT NOT NULL,
    "restoreTokenHash" TEXT,
    "restoreUntil" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "recoveryPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletion_restoreTokenHash_key" ON "AccountDeletion"("restoreTokenHash");
CREATE INDEX "AccountDeletion_userId_idx" ON "AccountDeletion"("userId");
CREATE INDEX "AccountDeletion_originalEmailHash_idx" ON "AccountDeletion"("originalEmailHash");
CREATE INDEX "AccountDeletion_restoreUntil_idx" ON "AccountDeletion"("restoreUntil");
CREATE INDEX "AccountDeletion_deletedAt_idx" ON "AccountDeletion"("deletedAt");

-- AddForeignKey
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
