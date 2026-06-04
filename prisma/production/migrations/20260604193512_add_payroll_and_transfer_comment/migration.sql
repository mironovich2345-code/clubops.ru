-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "transferComment" TEXT;

-- CreateTable
CREATE TABLE "PayrollStatement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "period" TEXT,
    "totalSignedAmountKopeks" INTEGER NOT NULL DEFAULT 0,
    "newSignedAmountKopeks" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "originalFileName" TEXT,
    "originalFileMime" TEXT,
    "originalFileSize" INTEGER,
    "originalFileStorageKey" TEXT,
    "rawExtractedJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollStatementRow" (
    "id" TEXT NOT NULL,
    "payrollStatementId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "employeeName" TEXT,
    "role" TEXT,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "isSigned" BOOLEAN NOT NULL DEFAULT false,
    "signatureDetectedConfidence" TEXT NOT NULL DEFAULT 'low',
    "rowHash" TEXT NOT NULL,
    "countedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollStatementRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollStatement_companyId_idx" ON "PayrollStatement"("companyId");

-- CreateIndex
CREATE INDEX "PayrollStatement_clubId_idx" ON "PayrollStatement"("clubId");

-- CreateIndex
CREATE INDEX "PayrollStatement_createdByUserId_idx" ON "PayrollStatement"("createdByUserId");

-- CreateIndex
CREATE INDEX "PayrollStatementRow_payrollStatementId_idx" ON "PayrollStatementRow"("payrollStatementId");

-- CreateIndex
CREATE INDEX "PayrollStatementRow_companyId_idx" ON "PayrollStatementRow"("companyId");

-- CreateIndex
CREATE INDEX "PayrollStatementRow_clubId_idx" ON "PayrollStatementRow"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollStatementRow_companyId_clubId_rowHash_key" ON "PayrollStatementRow"("companyId", "clubId", "rowHash");

-- AddForeignKey
ALTER TABLE "PayrollStatement" ADD CONSTRAINT "PayrollStatement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollStatement" ADD CONSTRAINT "PayrollStatement_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollStatement" ADD CONSTRAINT "PayrollStatement_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollStatementRow" ADD CONSTRAINT "PayrollStatementRow_payrollStatementId_fkey" FOREIGN KEY ("payrollStatementId") REFERENCES "PayrollStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

