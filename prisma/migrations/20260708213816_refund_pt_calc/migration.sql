-- AlterTable
ALTER TABLE "Refund" ADD COLUMN "ptAlternativeCalculationReason" TEXT;
ALTER TABLE "Refund" ADD COLUMN "ptCalculationMethod" TEXT;
ALTER TABLE "Refund" ADD COLUMN "ptContractSessionCount" INTEGER;
ALTER TABLE "Refund" ADD COLUMN "ptRawResultKopeks" INTEGER;
ALTER TABLE "Refund" ADD COLUMN "ptRefundUnavailableReason" TEXT;
ALTER TABLE "Refund" ADD COLUMN "ptRefusalDraftText" TEXT;
ALTER TABLE "Refund" ADD COLUMN "ptTerminationSessionPriceKopeks" INTEGER;
ALTER TABLE "Refund" ADD COLUMN "ptTrainerEmployeeId" TEXT;
ALTER TABLE "Refund" ADD COLUMN "ptTrainerNameSnapshot" TEXT;
ALTER TABLE "Refund" ADD COLUMN "ptUsedSessionCount" INTEGER;
