-- Multi-account (device-local) — Non-destructive additive migration (PostgreSQL).
-- Two new standalone tables; no change to User/Session. Scalar ids, no FK
-- (SettingsPinSession precedent).

-- CreateTable
CREATE TABLE "AccountSessionContainer" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "activeStoredSessionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "userAgentHash" TEXT,
    "deviceLabel" TEXT,
    CONSTRAINT "AccountSessionContainer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountSessionContainer_tokenHash_key" ON "AccountSessionContainer"("tokenHash");
CREATE INDEX "AccountSessionContainer_expiresAt_idx" ON "AccountSessionContainer"("expiresAt");
CREATE INDEX "AccountSessionContainer_revokedAt_idx" ON "AccountSessionContainer"("revokedAt");

-- CreateTable
CREATE TABLE "StoredAccountSession" (
    "id" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "StoredAccountSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoredAccountSession_containerId_userId_key" ON "StoredAccountSession"("containerId", "userId");
CREATE INDEX "StoredAccountSession_containerId_idx" ON "StoredAccountSession"("containerId");
CREATE INDEX "StoredAccountSession_sessionId_idx" ON "StoredAccountSession"("sessionId");
