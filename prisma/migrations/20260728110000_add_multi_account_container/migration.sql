-- Multi-account (device-local) — additive only. Two new standalone tables; no
-- change to User/Session. Scalar ids, no FK (SettingsPinSession precedent).

-- CreateTable
CREATE TABLE "AccountSessionContainer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "activeStoredSessionId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "userAgentHash" TEXT,
    "deviceLabel" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountSessionContainer_tokenHash_key" ON "AccountSessionContainer"("tokenHash");
CREATE INDEX "AccountSessionContainer_expiresAt_idx" ON "AccountSessionContainer"("expiresAt");
CREATE INDEX "AccountSessionContainer_revokedAt_idx" ON "AccountSessionContainer"("revokedAt");

-- CreateTable
CREATE TABLE "StoredAccountSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "StoredAccountSession_containerId_userId_key" ON "StoredAccountSession"("containerId", "userId");
CREATE INDEX "StoredAccountSession_containerId_idx" ON "StoredAccountSession"("containerId");
CREATE INDEX "StoredAccountSession_sessionId_idx" ON "StoredAccountSession"("sessionId");
