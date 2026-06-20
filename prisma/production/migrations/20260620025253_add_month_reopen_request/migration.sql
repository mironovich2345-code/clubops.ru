-- CreateTable
CREATE TABLE "MonthReopenRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewComment" TEXT,
    "executedByUserId" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthReopenRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonthReopenRequest_companyId_clubId_month_status_idx" ON "MonthReopenRequest"("companyId", "clubId", "month", "status");

-- CreateIndex
CREATE INDEX "MonthReopenRequest_companyId_idx" ON "MonthReopenRequest"("companyId");

-- CreateIndex
CREATE INDEX "MonthReopenRequest_status_idx" ON "MonthReopenRequest"("status");

-- AddForeignKey
ALTER TABLE "MonthReopenRequest" ADD CONSTRAINT "MonthReopenRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

