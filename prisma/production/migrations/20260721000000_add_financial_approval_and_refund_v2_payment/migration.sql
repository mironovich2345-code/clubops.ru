-- Non-destructive additive migration (production PostgreSQL).
-- Invoice: fingerprint of the approved financial data (payment guard).
-- Refund: v2 actual-payment stage fields + calculation-operand fingerprint.
-- Only ADD COLUMN of nullable columns. No DROP / TRUNCATE / DELETE, no table
-- rebuild. Existing rows keep NULL and behave exactly as before.
ALTER TABLE "Invoice" ADD COLUMN "approvedDataFingerprint" TEXT;
ALTER TABLE "Refund" ADD COLUMN "legalEntityId" TEXT;
ALTER TABLE "Refund" ADD COLUMN "paidByUserId" TEXT;
ALTER TABLE "Refund" ADD COLUMN "paymentComment" TEXT;
ALTER TABLE "Refund" ADD COLUMN "calculationInputHash" TEXT;
