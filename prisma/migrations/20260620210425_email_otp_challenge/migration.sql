-- CreateTable
CREATE TABLE "EmailOtpChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "challengeTokenHash" TEXT NOT NULL,
    "otpDigest" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'login',
    "expiresAt" DATETIME NOT NULL,
    "resendAvailableAt" DATETIME NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "sendCount" INTEGER NOT NULL DEFAULT 1,
    "lastSentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" DATETIME,
    "revokedAt" DATETIME,
    "revokedReason" TEXT,
    "deliveryFailedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailOtpChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailOtpChallenge_challengeTokenHash_key" ON "EmailOtpChallenge"("challengeTokenHash");

-- CreateIndex
CREATE INDEX "EmailOtpChallenge_userId_idx" ON "EmailOtpChallenge"("userId");

-- CreateIndex
CREATE INDEX "EmailOtpChallenge_expiresAt_idx" ON "EmailOtpChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "EmailOtpChallenge_consumedAt_idx" ON "EmailOtpChallenge"("consumedAt");

-- CreateIndex
CREATE INDEX "EmailOtpChallenge_revokedAt_idx" ON "EmailOtpChallenge"("revokedAt");
