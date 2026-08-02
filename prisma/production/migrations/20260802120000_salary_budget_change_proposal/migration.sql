-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "payrollAdvanceDay" INTEGER,
ADD COLUMN     "payrollFinalDay" INTEGER,
ADD COLUMN     "payrollTimezone" TEXT,
ADD COLUMN     "payrollWeekendRule" TEXT,
ADD COLUMN     "salaryBudgetIncludesTaxes" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "salaryBudgetSyncMode" TEXT NOT NULL DEFAULT 'suggested';

-- CreateTable
CREATE TABLE "BudgetChangeProposal" (
    "id" TEXT NOT NULL,
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
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "appliedBudgetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetChangeProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BudgetChangeProposal_companyId_idx" ON "BudgetChangeProposal"("companyId");

-- CreateIndex
CREATE INDEX "BudgetChangeProposal_clubId_category_month_idx" ON "BudgetChangeProposal"("clubId", "category", "month");

-- CreateIndex
CREATE INDEX "BudgetChangeProposal_status_idx" ON "BudgetChangeProposal"("status");

