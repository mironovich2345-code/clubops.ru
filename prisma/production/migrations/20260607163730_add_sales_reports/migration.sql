-- CreateTable
CREATE TABLE "SalesReport" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "reportDate" TIMESTAMP(3) NOT NULL,
    "managerName" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_accountant',
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "rejectedByUserId" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesReportLine" (
    "id" TEXT NOT NULL,
    "salesReportId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesReportLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesReportDocument" (
    "id" TEXT NOT NULL,
    "salesReportId" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "originalFileMime" TEXT NOT NULL,
    "originalFileSize" INTEGER NOT NULL,
    "storageKey" TEXT,
    "uploadedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesReportDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesReport_companyId_idx" ON "SalesReport"("companyId");

-- CreateIndex
CREATE INDEX "SalesReport_clubId_idx" ON "SalesReport"("clubId");

-- CreateIndex
CREATE INDEX "SalesReport_status_idx" ON "SalesReport"("status");

-- CreateIndex
CREATE INDEX "SalesReport_reportDate_idx" ON "SalesReport"("reportDate");

-- CreateIndex
CREATE INDEX "SalesReportLine_salesReportId_idx" ON "SalesReportLine"("salesReportId");

-- CreateIndex
CREATE INDEX "SalesReportDocument_salesReportId_idx" ON "SalesReportDocument"("salesReportId");

-- AddForeignKey
ALTER TABLE "SalesReport" ADD CONSTRAINT "SalesReport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReport" ADD CONSTRAINT "SalesReport_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReport" ADD CONSTRAINT "SalesReport_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReportLine" ADD CONSTRAINT "SalesReportLine_salesReportId_fkey" FOREIGN KEY ("salesReportId") REFERENCES "SalesReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReportDocument" ADD CONSTRAINT "SalesReportDocument_salesReportId_fkey" FOREIGN KEY ("salesReportId") REFERENCES "SalesReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

