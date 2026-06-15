-- AlterTable
ALTER TABLE "SalesReport" ADD COLUMN     "managerEmployeeId" TEXT;

-- CreateTable
CREATE TABLE "ClubEmployee" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "dismissedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubEmployee_companyId_idx" ON "ClubEmployee"("companyId");

-- CreateIndex
CREATE INDEX "ClubEmployee_clubId_idx" ON "ClubEmployee"("clubId");

-- CreateIndex
CREATE INDEX "ClubEmployee_clubId_position_status_idx" ON "ClubEmployee"("clubId", "position", "status");

-- AddForeignKey
ALTER TABLE "SalesReport" ADD CONSTRAINT "SalesReport_managerEmployeeId_fkey" FOREIGN KEY ("managerEmployeeId") REFERENCES "ClubEmployee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEmployee" ADD CONSTRAINT "ClubEmployee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEmployee" ADD CONSTRAINT "ClubEmployee_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

