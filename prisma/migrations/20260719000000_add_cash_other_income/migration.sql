-- Non-destructive: new CashOtherIncome table + optional otherIncomeId link on
-- CashOperationDocument. No changes to existing data; existing balances untouched.

-- CreateTable
CREATE TABLE "CashOtherIncome" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "operationDate" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'other',
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "createdByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" DATETIME,
    "reviewReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "CashOtherIncome_companyId_clubId_idx" ON "CashOtherIncome"("companyId", "clubId");
CREATE INDEX "CashOtherIncome_clubId_legalEntityId_status_idx" ON "CashOtherIncome"("clubId", "legalEntityId", "status");
CREATE INDEX "CashOtherIncome_status_idx" ON "CashOtherIncome"("status");
CREATE INDEX "CashOtherIncome_operationDate_idx" ON "CashOtherIncome"("operationDate");

-- AlterTable
ALTER TABLE "CashOperationDocument" ADD COLUMN "otherIncomeId" TEXT;

-- CreateIndex
CREATE INDEX "CashOperationDocument_otherIncomeId_idx" ON "CashOperationDocument"("otherIncomeId");
