-- AlterTable
ALTER TABLE "BalanceSnapshot" ADD COLUMN     "correctionReason" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "supersedesSnapshotId" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "CashRegionalTransfer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "operationDate" TIMESTAMP(3) NOT NULL,
    "recipientRegionalDirectorId" TEXT NOT NULL,
    "recipientNameSnapshot" TEXT NOT NULL,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_confirmation',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "CashRegionalTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashRegionalTransfer_idempotencyKey_key" ON "CashRegionalTransfer"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CashRegionalTransfer_companyId_clubId_idx" ON "CashRegionalTransfer"("companyId", "clubId");

-- CreateIndex
CREATE INDEX "CashRegionalTransfer_clubId_legalEntityId_status_idx" ON "CashRegionalTransfer"("clubId", "legalEntityId", "status");

-- CreateIndex
CREATE INDEX "CashRegionalTransfer_status_idx" ON "CashRegionalTransfer"("status");

-- CreateIndex
CREATE INDEX "CashRegionalTransfer_operationDate_idx" ON "CashRegionalTransfer"("operationDate");

-- CreateIndex
CREATE INDEX "CashRegionalTransfer_recipientRegionalDirectorId_idx" ON "CashRegionalTransfer"("recipientRegionalDirectorId");

-- CreateIndex
CREATE INDEX "BalanceSnapshot_clubId_legalEntityId_status_snapshotDate_idx" ON "BalanceSnapshot"("clubId", "legalEntityId", "status", "snapshotDate");

