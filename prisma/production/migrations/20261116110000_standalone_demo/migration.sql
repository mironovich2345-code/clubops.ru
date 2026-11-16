-- Dedicated demo database only; never run this branch against production.
DO $$ BEGIN
  IF current_database() NOT LIKE 'clubops_demo_%' THEN
    RAISE EXCEPTION 'Standalone demo requires a dedicated clubops_demo_* database';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "CashOperationDocument" ADD COLUMN     "migrationStatus" TEXT,
ADD COLUMN     "storageBucket" TEXT,
ADD COLUMN     "storageProvider" TEXT,
ADD COLUMN     "supersedesFileId" TEXT,
ADD COLUMN     "uploadOperationKey" TEXT,
ADD COLUMN     "verificationStatus" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ExpenseDocument" ADD COLUMN     "migrationStatus" TEXT,
ADD COLUMN     "storageBucket" TEXT,
ADD COLUMN     "storageProvider" TEXT,
ADD COLUMN     "supersedesFileId" TEXT,
ADD COLUMN     "uploadOperationKey" TEXT,
ADD COLUMN     "verificationStatus" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RefundDocument" ADD COLUMN     "migrationStatus" TEXT,
ADD COLUMN     "storageBucket" TEXT,
ADD COLUMN     "storageProvider" TEXT,
ADD COLUMN     "supersedesFileId" TEXT,
ADD COLUMN     "uploadOperationKey" TEXT,
ADD COLUMN     "verificationStatus" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SalesReportDocument" ADD COLUMN     "migrationStatus" TEXT,
ADD COLUMN     "sha256" TEXT,
ADD COLUMN     "storageBucket" TEXT,
ADD COLUMN     "storageProvider" TEXT,
ADD COLUMN     "supersedesFileId" TEXT,
ADD COLUMN     "uploadOperationKey" TEXT,
ADD COLUMN     "verificationStatus" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" TEXT,
    "eventType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "outcome" TEXT NOT NULL DEFAULT 'denied',
    "reasonCode" TEXT,
    "actorId" TEXT,
    "companyId" TEXT,
    "clubId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "route" TEXT,
    "source" TEXT NOT NULL DEFAULT 'web',
    "metadataJson" TEXT,
    "deploymentVersion" TEXT,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoVisit" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "usersJson" TEXT NOT NULL,
    "clubsJson" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_eventType_createdAt_idx" ON "SecurityEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_companyId_createdAt_idx" ON "SecurityEvent"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_actorId_createdAt_idx" ON "SecurityEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_requestId_idx" ON "SecurityEvent"("requestId");

-- CreateIndex
CREATE INDEX "SecurityEvent_severity_createdAt_idx" ON "SecurityEvent"("severity", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DemoVisit_tokenHash_key" ON "DemoVisit"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "DemoVisit_companyId_key" ON "DemoVisit"("companyId");

-- CreateIndex
CREATE INDEX "DemoVisit_expiresAt_idx" ON "DemoVisit"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CashOperationDocument_uploadOperationKey_key" ON "CashOperationDocument"("uploadOperationKey");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseDocument_uploadOperationKey_key" ON "ExpenseDocument"("uploadOperationKey");

-- CreateIndex
CREATE INDEX "OfdReceiptImport_operatorNormalized_idx" ON "OfdReceiptImport"("operatorNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "RefundDocument_uploadOperationKey_key" ON "RefundDocument"("uploadOperationKey");

-- CreateIndex
CREATE UNIQUE INDEX "SalesReportDocument_uploadOperationKey_key" ON "SalesReportDocument"("uploadOperationKey");
