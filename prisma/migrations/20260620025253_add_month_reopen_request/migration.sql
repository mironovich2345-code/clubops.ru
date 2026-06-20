-- CreateTable
CREATE TABLE "MonthReopenRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByUserId" TEXT,
    "reviewedAt" DATETIME,
    "reviewComment" TEXT,
    "executedByUserId" TEXT,
    "executedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MonthReopenRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MonthReopenRequest_companyId_clubId_month_status_idx" ON "MonthReopenRequest"("companyId", "clubId", "month", "status");

-- CreateIndex
CREATE INDEX "MonthReopenRequest_companyId_idx" ON "MonthReopenRequest"("companyId");

-- CreateIndex
CREATE INDEX "MonthReopenRequest_status_idx" ON "MonthReopenRequest"("status");
