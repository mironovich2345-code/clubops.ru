-- CreateTable
CREATE TABLE "BudgetChangeProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "currentLimitKopeks" INTEGER NOT NULL,
    "proposedLimitKopeks" INTEGER NOT NULL,
    "forecastKopeks" INTEGER,
    "reason" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposedByUserId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    "appliedBudgetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "inn" TEXT,
    "kpp" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "primaryOwnerUserId" TEXT,
    "settingsPinHash" TEXT,
    "settingsPinSetAt" DATETIME,
    "settingsPinSetByUserId" TEXT,
    "settingsPinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
    "settingsPinLockedUntil" DATETIME,
    "salaryBudgetSyncMode" TEXT NOT NULL DEFAULT 'suggested',
    "salaryBudgetIncludesTaxes" BOOLEAN NOT NULL DEFAULT false,
    "payrollAdvanceDay" INTEGER,
    "payrollFinalDay" INTEGER,
    "payrollWeekendRule" TEXT,
    "payrollTimezone" TEXT
);
INSERT INTO "new_Company" ("createdAt", "id", "inn", "kpp", "name", "primaryOwnerUserId", "settingsPinFailedAttempts", "settingsPinHash", "settingsPinLockedUntil", "settingsPinSetAt", "settingsPinSetByUserId", "updatedAt") SELECT "createdAt", "id", "inn", "kpp", "name", "primaryOwnerUserId", "settingsPinFailedAttempts", "settingsPinHash", "settingsPinLockedUntil", "settingsPinSetAt", "settingsPinSetByUserId", "updatedAt" FROM "Company";
DROP TABLE "Company";
ALTER TABLE "new_Company" RENAME TO "Company";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "BudgetChangeProposal_companyId_idx" ON "BudgetChangeProposal"("companyId");

-- CreateIndex
CREATE INDEX "BudgetChangeProposal_clubId_category_month_idx" ON "BudgetChangeProposal"("clubId", "category", "month");

-- CreateIndex
CREATE INDEX "BudgetChangeProposal_status_idx" ON "BudgetChangeProposal"("status");

