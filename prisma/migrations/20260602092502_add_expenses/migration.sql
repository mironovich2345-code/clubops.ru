-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "vendorName" TEXT,
    "amountKopeks" INTEGER NOT NULL,
    "expenseDate" DATETIME NOT NULL,
    "paymentMethod" TEXT,
    "comment" TEXT,
    "fileUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Expense_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Expense_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Expense_clubId_idx" ON "Expense"("clubId");

-- CreateIndex
CREATE INDEX "Expense_createdByUserId_idx" ON "Expense"("createdByUserId");

-- CreateIndex
CREATE INDEX "Expense_category_idx" ON "Expense"("category");

-- CreateIndex
CREATE INDEX "Expense_expenseDate_idx" ON "Expense"("expenseDate");
