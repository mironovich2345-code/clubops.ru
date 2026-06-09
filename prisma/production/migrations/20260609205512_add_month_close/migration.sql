-- CreateTable
CREATE TABLE "MonthClose" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'closed',
    "closedByUserId" TEXT,
    "closedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonthClose_companyId_idx" ON "MonthClose"("companyId");

-- CreateIndex
CREATE INDEX "MonthClose_month_idx" ON "MonthClose"("month");

-- CreateIndex
CREATE UNIQUE INDEX "MonthClose_companyId_clubId_month_key" ON "MonthClose"("companyId", "clubId", "month");

-- AddForeignKey
ALTER TABLE "MonthClose" ADD CONSTRAINT "MonthClose_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

