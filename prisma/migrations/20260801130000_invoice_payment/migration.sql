-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "paymentDate" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "method" TEXT,
    "comment" TEXT,
    "proofDocumentId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "reversedById" TEXT,
    "reversedAt" DATETIME,
    "reversalReason" TEXT,
    "reversesPaymentId" TEXT,
    "idempotencyKey" TEXT,
    "enteredAfterPayment" BOOLEAN NOT NULL DEFAULT false,
    "legacyBackfill" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_idempotencyKey_key" ON "InvoicePayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "InvoicePayment_companyId_idx" ON "InvoicePayment"("companyId");

-- CreateIndex
CREATE INDEX "InvoicePayment_invoiceId_status_idx" ON "InvoicePayment"("invoiceId", "status");

-- CreateIndex
CREATE INDEX "InvoicePayment_paymentDate_idx" ON "InvoicePayment"("paymentDate");

-- CreateIndex
CREATE INDEX "InvoicePayment_status_idx" ON "InvoicePayment"("status");

