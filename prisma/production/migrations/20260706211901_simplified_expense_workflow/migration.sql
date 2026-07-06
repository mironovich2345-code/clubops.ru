-- Additive simplified cash-expense workflow. No column removed, no row rewritten;
-- existing expenses stay entryVersion=1 with unchanged behavior.

-- Expense: simplified-workflow columns (all nullable / safe defaults).
ALTER TABLE "Expense" ADD COLUMN "entryVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Expense" ADD COLUMN "shoppingListText" TEXT;
ALTER TABLE "Expense" ADD COLUMN "generatedTitle" TEXT;
ALTER TABLE "Expense" ADD COLUMN "paidByUserId" TEXT;
ALTER TABLE "Expense" ADD COLUMN "aiCheckStatus" TEXT;
ALTER TABLE "Expense" ADD COLUMN "aiCheckSummary" TEXT;
ALTER TABLE "Expense" ADD COLUMN "submittedAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN "verifiedAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN "verifiedByUserId" TEXT;
ALTER TABLE "Expense" ADD COLUMN "correctionRequestedAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN "correctionRequestedByUserId" TEXT;
ALTER TABLE "Expense" ADD COLUMN "correctionReason" TEXT;
ALTER TABLE "Expense" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN "cancelledByUserId" TEXT;
ALTER TABLE "Expense" ADD COLUMN "cancellationReason" TEXT;
ALTER TABLE "Expense" ADD COLUMN "firstSavedAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN "budgetOverrunKopeks" INTEGER;
ALTER TABLE "Expense" ADD COLUMN "budgetOverrunBasisPoints" INTEGER;
ALTER TABLE "Expense" ADD COLUMN "budgetApprovalLevel" TEXT;

CREATE INDEX "Expense_status_idx" ON "Expense"("status");
CREATE INDEX "Expense_entryVersion_idx" ON "Expense"("entryVersion");
CREATE INDEX "Expense_paidByUserId_idx" ON "Expense"("paidByUserId");

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_paidByUserId_fkey" FOREIGN KEY ("paidByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ExpenseCategory + rename history.
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExpenseCategory_key_key" ON "ExpenseCategory"("key");
CREATE INDEX "ExpenseCategory_isActive_idx" ON "ExpenseCategory"("isActive");

CREATE TABLE "ExpenseCategoryNameHistory" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "changedByUserId" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExpenseCategoryNameHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ExpenseCategoryNameHistory_categoryId_idx" ON "ExpenseCategoryNameHistory"("categoryId");
ALTER TABLE "ExpenseCategoryNameHistory" ADD CONSTRAINT "ExpenseCategoryNameHistory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
