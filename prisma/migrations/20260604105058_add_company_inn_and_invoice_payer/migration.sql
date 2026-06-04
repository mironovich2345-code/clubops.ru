-- AlterTable
ALTER TABLE "Company" ADD COLUMN "inn" TEXT;
ALTER TABLE "Company" ADD COLUMN "kpp" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "payerInn" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "payerKpp" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "payerName" TEXT;
