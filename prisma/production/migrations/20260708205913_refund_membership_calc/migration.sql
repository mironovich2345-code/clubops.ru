-- AlterTable (additive; all nullable / defaulted → legacy rows unaffected)
ALTER TABLE "Refund" ADD COLUMN "serviceStartDate" TIMESTAMP(3);
ALTER TABLE "Refund" ADD COLUMN "serviceEndDate" TIMESTAMP(3);
ALTER TABLE "Refund" ADD COLUMN "applicationDate" TIMESTAMP(3);
ALTER TABLE "Refund" ADD COLUMN "contractAmountKopeks" INTEGER;
ALTER TABLE "Refund" ADD COLUMN "serviceNotProvided" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Refund" ADD COLUMN "serviceDurationDays" INTEGER;
ALTER TABLE "Refund" ADD COLUMN "refundableDays" INTEGER;
ALTER TABLE "Refund" ADD COLUMN "refundResultAmountKopeks" INTEGER;
ALTER TABLE "Refund" ADD COLUMN "baseRefundDueDate" TIMESTAMP(3);
ALTER TABLE "Refund" ADD COLUMN "plannedRefundDate" TIMESTAMP(3);
ALTER TABLE "Refund" ADD COLUMN "dueDateAdjustmentReason" TEXT;
ALTER TABLE "Refund" ADD COLUMN "calculationVersion" TEXT;
