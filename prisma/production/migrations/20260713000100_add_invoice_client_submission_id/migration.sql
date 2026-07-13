-- AlterTable (additive; nullable → legacy Invoice rows unaffected)
ALTER TABLE "Invoice" ADD COLUMN "clientSubmissionId" TEXT;

-- Idempotency key: unique but nullable (many NULLs allowed in a unique index).
CREATE UNIQUE INDEX "Invoice_clientSubmissionId_key" ON "Invoice"("clientSubmissionId");
