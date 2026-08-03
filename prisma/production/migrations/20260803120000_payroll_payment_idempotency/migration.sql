-- AlterTable
ALTER TABLE "PayrollPayment" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "paymentType" TEXT,
ADD COLUMN     "requestFingerprint" TEXT;

-- AlterTable
ALTER TABLE "RegionalCityPayment" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "requestFingerprint" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPayment_companyId_idempotencyKey_key" ON "PayrollPayment"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RegionalCityPayment_companyId_idempotencyKey_key" ON "RegionalCityPayment"("companyId", "idempotencyKey");

