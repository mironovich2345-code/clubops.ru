-- Non-destructive: new CashOtherIncome table + optional otherIncomeId link on
-- CashOperationDocument. No changes to existing data; existing balances untouched.

-- CreateTable
CREATE TABLE "CashOtherIncome" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "operationDate" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'other',
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "createdByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashOtherIncome_pkey" PRIMARY KEY ("id")
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
