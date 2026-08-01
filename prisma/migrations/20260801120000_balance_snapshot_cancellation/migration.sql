-- AlterTable
ALTER TABLE "BalanceSnapshot" ADD COLUMN "cancellationReason" TEXT;
ALTER TABLE "BalanceSnapshot" ADD COLUMN "cancelledAt" DATETIME;
ALTER TABLE "BalanceSnapshot" ADD COLUMN "cancelledById" TEXT;

