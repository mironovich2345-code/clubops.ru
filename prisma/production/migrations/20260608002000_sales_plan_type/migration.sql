-- AlterTable
ALTER TABLE "SalesPlan" ADD COLUMN     "planType" TEXT NOT NULL DEFAULT 'total';

-- CreateIndex
CREATE UNIQUE INDEX "SalesPlan_companyId_clubId_month_planType_key" ON "SalesPlan"("companyId", "clubId", "month", "planType");

