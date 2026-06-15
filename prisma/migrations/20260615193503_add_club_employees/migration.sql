-- CreateTable
CREATE TABLE "ClubEmployee" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "dismissedAt" DATETIME,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClubEmployee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClubEmployee_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SalesReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "reportDate" DATETIME NOT NULL,
    "managerName" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_accountant',
    "verifiedByUserId" TEXT,
    "verifiedAt" DATETIME,
    "accountantComment" TEXT,
    "rejectedByUserId" TEXT,
    "rejectedAt" DATETIME,
    "rejectionReason" TEXT,
    "notes" TEXT,
    "importBatchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "managerEmployeeId" TEXT,
    CONSTRAINT "SalesReport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesReport_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesReport_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SalesReport_managerEmployeeId_fkey" FOREIGN KEY ("managerEmployeeId") REFERENCES "ClubEmployee" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SalesReport" ("accountantComment", "clubId", "companyId", "createdAt", "createdByUserId", "id", "importBatchId", "managerName", "notes", "rejectedAt", "rejectedByUserId", "rejectionReason", "reportDate", "status", "updatedAt", "verifiedAt", "verifiedByUserId") SELECT "accountantComment", "clubId", "companyId", "createdAt", "createdByUserId", "id", "importBatchId", "managerName", "notes", "rejectedAt", "rejectedByUserId", "rejectionReason", "reportDate", "status", "updatedAt", "verifiedAt", "verifiedByUserId" FROM "SalesReport";
DROP TABLE "SalesReport";
ALTER TABLE "new_SalesReport" RENAME TO "SalesReport";
CREATE INDEX "SalesReport_companyId_idx" ON "SalesReport"("companyId");
CREATE INDEX "SalesReport_clubId_idx" ON "SalesReport"("clubId");
CREATE INDEX "SalesReport_status_idx" ON "SalesReport"("status");
CREATE INDEX "SalesReport_reportDate_idx" ON "SalesReport"("reportDate");
CREATE INDEX "SalesReport_importBatchId_idx" ON "SalesReport"("importBatchId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ClubEmployee_companyId_idx" ON "ClubEmployee"("companyId");

-- CreateIndex
CREATE INDEX "ClubEmployee_clubId_idx" ON "ClubEmployee"("clubId");

-- CreateIndex
CREATE INDEX "ClubEmployee_clubId_position_status_idx" ON "ClubEmployee"("clubId", "position", "status");
