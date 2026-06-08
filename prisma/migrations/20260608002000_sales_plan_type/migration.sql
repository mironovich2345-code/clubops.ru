-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SalesPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT,
    "month" TEXT NOT NULL,
    "planType" TEXT NOT NULL DEFAULT 'total',
    "targetAmountKopeks" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalesPlan_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesPlan_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesPlan_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SalesPlan" ("clubId", "companyId", "createdAt", "createdByUserId", "id", "month", "targetAmountKopeks", "updatedAt") SELECT "clubId", "companyId", "createdAt", "createdByUserId", "id", "month", "targetAmountKopeks", "updatedAt" FROM "SalesPlan";
DROP TABLE "SalesPlan";
ALTER TABLE "new_SalesPlan" RENAME TO "SalesPlan";
CREATE INDEX "SalesPlan_companyId_idx" ON "SalesPlan"("companyId");
CREATE INDEX "SalesPlan_clubId_idx" ON "SalesPlan"("clubId");
CREATE INDEX "SalesPlan_month_idx" ON "SalesPlan"("month");
CREATE UNIQUE INDEX "SalesPlan_companyId_clubId_month_planType_key" ON "SalesPlan"("companyId", "clubId", "month", "planType");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
