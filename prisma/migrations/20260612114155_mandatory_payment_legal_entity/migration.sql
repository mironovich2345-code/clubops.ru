-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MandatoryPaymentPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "dueDayOfMonth" INTEGER,
    "dueDate" DATETIME,
    "recurrence" TEXT NOT NULL DEFAULT 'monthly',
    "responsibleUserId" TEXT,
    "legalEntityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MandatoryPaymentPlan_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MandatoryPaymentPlan_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MandatoryPaymentPlan_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MandatoryPaymentPlan_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MandatoryPaymentPlan_responsibleUserId_fkey" FOREIGN KEY ("responsibleUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MandatoryPaymentPlan" ("amountKopeks", "category", "clubId", "companyId", "createdAt", "createdByUserId", "dueDate", "dueDayOfMonth", "id", "isActive", "notes", "recurrence", "responsibleUserId", "status", "title", "updatedAt") SELECT "amountKopeks", "category", "clubId", "companyId", "createdAt", "createdByUserId", "dueDate", "dueDayOfMonth", "id", "isActive", "notes", "recurrence", "responsibleUserId", "status", "title", "updatedAt" FROM "MandatoryPaymentPlan";
DROP TABLE "MandatoryPaymentPlan";
ALTER TABLE "new_MandatoryPaymentPlan" RENAME TO "MandatoryPaymentPlan";
CREATE INDEX "MandatoryPaymentPlan_companyId_idx" ON "MandatoryPaymentPlan"("companyId");
CREATE INDEX "MandatoryPaymentPlan_clubId_idx" ON "MandatoryPaymentPlan"("clubId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
