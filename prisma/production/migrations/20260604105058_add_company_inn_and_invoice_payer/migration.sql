-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "inn" TEXT,
ADD COLUMN     "kpp" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "payerInn" TEXT,
ADD COLUMN     "payerKpp" TEXT,
ADD COLUMN     "payerName" TEXT;
