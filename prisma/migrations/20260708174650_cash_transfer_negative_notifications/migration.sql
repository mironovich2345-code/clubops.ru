-- CreateTable
CREATE TABLE "CashNotification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "recipientRole" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "thresholdKopeks" INTEGER NOT NULL,
    "balanceKopeks" INTEGER NOT NULL,
    "regionalDirectorId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "linkPath" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CashNotification_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CashNotification_dedupeKey_key" ON "CashNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "CashNotification_companyId_recipientRole_readAt_idx" ON "CashNotification"("companyId", "recipientRole", "readAt");

-- CreateIndex
CREATE INDEX "CashNotification_clubId_idx" ON "CashNotification"("clubId");

-- CreateIndex
CREATE INDEX "CashNotification_walletId_idx" ON "CashNotification"("walletId");
