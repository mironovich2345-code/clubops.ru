-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "limitAmountKopeks" INTEGER NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Budget_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Budget_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Budget_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BudgetApprovalRequest" (
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
    "status" TEXT NOT NULL DEFAULT 'pending_regional',
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

-- CreateIndex
CREATE INDEX "Budget_companyId_idx" ON "Budget"("companyId");

-- CreateIndex
CREATE INDEX "Budget_clubId_idx" ON "Budget"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_clubId_category_month_key" ON "Budget"("clubId", "category", "month");

-- CreateIndex
CREATE INDEX "BudgetApprovalRequest_companyId_idx" ON "BudgetApprovalRequest"("companyId");

-- CreateIndex
CREATE INDEX "BudgetApprovalRequest_clubId_idx" ON "BudgetApprovalRequest"("clubId");

-- CreateIndex
CREATE INDEX "BudgetApprovalRequest_status_idx" ON "BudgetApprovalRequest"("status");
