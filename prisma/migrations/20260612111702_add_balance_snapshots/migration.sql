-- CreateTable
CREATE TABLE "BalanceSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "snapshotDate" DATETIME NOT NULL,
    "actualBalanceKopeks" INTEGER NOT NULL,
    "comment" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BalanceSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BalanceSnapshot_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BalanceSnapshot_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BalanceSnapshot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BalanceSnapshot_companyId_idx" ON "BalanceSnapshot"("companyId");

-- CreateIndex
CREATE INDEX "BalanceSnapshot_clubId_idx" ON "BalanceSnapshot"("clubId");

-- CreateIndex
CREATE INDEX "BalanceSnapshot_legalEntityId_idx" ON "BalanceSnapshot"("legalEntityId");

-- CreateIndex
CREATE INDEX "BalanceSnapshot_clubId_legalEntityId_snapshotDate_idx" ON "BalanceSnapshot"("clubId", "legalEntityId", "snapshotDate");
