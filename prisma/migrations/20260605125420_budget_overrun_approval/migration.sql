-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BudgetApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "requestedAmountKopeks" INTEGER NOT NULL,
    "currentLimitAmountKopeks" INTEGER NOT NULL,
    "overByAmountKopeks" INTEGER NOT NULL,
    "overByPercent" REAL NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "budgetId" TEXT,
    "budgetAmountKopeks" INTEGER NOT NULL DEFAULT 0,
    "currentSpentKopeks" INTEGER NOT NULL DEFAULT 0,
    "projectedSpentKopeks" INTEGER NOT NULL DEFAULT 0,
    "overrunKopeks" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" DATETIME,
    "rejectedByUserId" TEXT,
    "rejectedAt" DATETIME,
    "decidedByUserId" TEXT,
    "decidedAt" DATETIME,
    "decisionComment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BudgetApprovalRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BudgetApprovalRequest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BudgetApprovalRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BudgetApprovalRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BudgetApprovalRequest" ("category", "clubId", "companyId", "createdAt", "currentLimitAmountKopeks", "decidedAt", "decidedByUserId", "decisionComment", "id", "month", "overByAmountKopeks", "overByPercent", "requestedAmountKopeks", "requestedByUserId", "sourceId", "sourceType", "status", "updatedAt") SELECT "category", "clubId", "companyId", "createdAt", "currentLimitAmountKopeks", "decidedAt", "decidedByUserId", "decisionComment", "id", "month", "overByAmountKopeks", "overByPercent", "requestedAmountKopeks", "requestedByUserId", "sourceId", "sourceType", "status", "updatedAt" FROM "BudgetApprovalRequest";
DROP TABLE "BudgetApprovalRequest";
ALTER TABLE "new_BudgetApprovalRequest" RENAME TO "BudgetApprovalRequest";
CREATE INDEX "BudgetApprovalRequest_companyId_idx" ON "BudgetApprovalRequest"("companyId");
CREATE INDEX "BudgetApprovalRequest_clubId_idx" ON "BudgetApprovalRequest"("clubId");
CREATE INDEX "BudgetApprovalRequest_status_idx" ON "BudgetApprovalRequest"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
