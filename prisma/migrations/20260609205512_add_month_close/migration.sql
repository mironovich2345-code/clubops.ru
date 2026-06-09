-- CreateTable
CREATE TABLE "MonthClose" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'closed',
    "closedByUserId" TEXT,
    "closedAt" DATETIME,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MonthClose_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MonthClose_companyId_idx" ON "MonthClose"("companyId");

-- CreateIndex
CREATE INDEX "MonthClose_month_idx" ON "MonthClose"("month");

-- CreateIndex
CREATE UNIQUE INDEX "MonthClose_companyId_clubId_month_key" ON "MonthClose"("companyId", "clubId", "month");
