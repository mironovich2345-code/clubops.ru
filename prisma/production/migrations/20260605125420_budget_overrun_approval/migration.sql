-- AlterTable
ALTER TABLE "BudgetApprovalRequest" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "budgetAmountKopeks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "budgetId" TEXT,
ADD COLUMN     "currentSpentKopeks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "overrunKopeks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "projectedSpentKopeks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedByUserId" TEXT,
ALTER COLUMN "status" SET DEFAULT 'pending';

