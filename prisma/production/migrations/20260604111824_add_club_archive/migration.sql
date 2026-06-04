-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
