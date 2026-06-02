-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "address" TEXT,
ADD COLUMN     "confidence" TEXT NOT NULL DEFAULT 'low',
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'RUB',
ADD COLUMN     "itemsJson" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "originalFileMime" TEXT,
ADD COLUMN     "originalFileName" TEXT,
ADD COLUMN     "originalFileSize" INTEGER,
ADD COLUMN     "originalFileStorageKey" TEXT,
ADD COLUMN     "rawExtractedJson" TEXT,
ADD COLUMN     "recipientName" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'confirmed',
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'manual',
ALTER COLUMN "amountKopeks" SET DEFAULT 0;

