-- REM-04: additive file-durability metadata. All columns nullable, NO backfill.
-- SQLite cannot add a UNIQUE column inline, so ADD COLUMN then CREATE UNIQUE INDEX
-- (a unique index over a nullable column permits many NULLs).

-- RefundDocument
ALTER TABLE "RefundDocument" ADD COLUMN "storageProvider" TEXT;
ALTER TABLE "RefundDocument" ADD COLUMN "storageBucket" TEXT;
ALTER TABLE "RefundDocument" ADD COLUMN "verificationStatus" TEXT;
ALTER TABLE "RefundDocument" ADD COLUMN "verifiedAt" DATETIME;
ALTER TABLE "RefundDocument" ADD COLUMN "uploadOperationKey" TEXT;
ALTER TABLE "RefundDocument" ADD COLUMN "supersedesFileId" TEXT;
ALTER TABLE "RefundDocument" ADD COLUMN "migrationStatus" TEXT;
CREATE UNIQUE INDEX "RefundDocument_uploadOperationKey_key" ON "RefundDocument"("uploadOperationKey");

-- ExpenseDocument
ALTER TABLE "ExpenseDocument" ADD COLUMN "storageProvider" TEXT;
ALTER TABLE "ExpenseDocument" ADD COLUMN "storageBucket" TEXT;
ALTER TABLE "ExpenseDocument" ADD COLUMN "verificationStatus" TEXT;
ALTER TABLE "ExpenseDocument" ADD COLUMN "verifiedAt" DATETIME;
ALTER TABLE "ExpenseDocument" ADD COLUMN "uploadOperationKey" TEXT;
ALTER TABLE "ExpenseDocument" ADD COLUMN "supersedesFileId" TEXT;
ALTER TABLE "ExpenseDocument" ADD COLUMN "migrationStatus" TEXT;
CREATE UNIQUE INDEX "ExpenseDocument_uploadOperationKey_key" ON "ExpenseDocument"("uploadOperationKey");

-- CashOperationDocument
ALTER TABLE "CashOperationDocument" ADD COLUMN "storageProvider" TEXT;
ALTER TABLE "CashOperationDocument" ADD COLUMN "storageBucket" TEXT;
ALTER TABLE "CashOperationDocument" ADD COLUMN "verificationStatus" TEXT;
ALTER TABLE "CashOperationDocument" ADD COLUMN "verifiedAt" DATETIME;
ALTER TABLE "CashOperationDocument" ADD COLUMN "uploadOperationKey" TEXT;
ALTER TABLE "CashOperationDocument" ADD COLUMN "supersedesFileId" TEXT;
ALTER TABLE "CashOperationDocument" ADD COLUMN "migrationStatus" TEXT;
CREATE UNIQUE INDEX "CashOperationDocument_uploadOperationKey_key" ON "CashOperationDocument"("uploadOperationKey");

-- SalesReportDocument
ALTER TABLE "SalesReportDocument" ADD COLUMN "sha256" TEXT;
ALTER TABLE "SalesReportDocument" ADD COLUMN "storageProvider" TEXT;
ALTER TABLE "SalesReportDocument" ADD COLUMN "storageBucket" TEXT;
ALTER TABLE "SalesReportDocument" ADD COLUMN "verificationStatus" TEXT;
ALTER TABLE "SalesReportDocument" ADD COLUMN "verifiedAt" DATETIME;
ALTER TABLE "SalesReportDocument" ADD COLUMN "uploadOperationKey" TEXT;
ALTER TABLE "SalesReportDocument" ADD COLUMN "supersedesFileId" TEXT;
ALTER TABLE "SalesReportDocument" ADD COLUMN "migrationStatus" TEXT;
CREATE UNIQUE INDEX "SalesReportDocument_uploadOperationKey_key" ON "SalesReportDocument"("uploadOperationKey");
