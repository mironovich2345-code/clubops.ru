-- Additive: cash wallets + cash-movement ledger + Expense.cashWalletId.
-- No column removed, no data migrated; existing expenses/statuses unchanged.

ALTER TABLE "Expense" ADD COLUMN "cashWalletId" TEXT;

CREATE TABLE "CashWallet" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "holderUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CashWallet_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CashWallet_companyId_idx" ON "CashWallet"("companyId");
CREATE INDEX "CashWallet_clubId_legalEntityId_idx" ON "CashWallet"("clubId", "legalEntityId");
CREATE INDEX "CashWallet_holderUserId_idx" ON "CashWallet"("holderUserId");
CREATE UNIQUE INDEX "CashWallet_clubId_legalEntityId_type_holderUserId_key" ON "CashWallet"("clubId", "legalEntityId", "type", "holderUserId");

CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "fromWalletId" TEXT,
    "toWalletId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "sourceType" TEXT,
    "sourceId" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CashMovement_sourceType_sourceId_key" ON "CashMovement"("sourceType", "sourceId");
CREATE INDEX "CashMovement_clubId_legalEntityId_status_idx" ON "CashMovement"("clubId", "legalEntityId", "status");
CREATE INDEX "CashMovement_toWalletId_status_idx" ON "CashMovement"("toWalletId", "status");
CREATE INDEX "CashMovement_fromWalletId_status_idx" ON "CashMovement"("fromWalletId", "status");
CREATE INDEX "CashMovement_type_idx" ON "CashMovement"("type");
CREATE INDEX "CashMovement_occurredAt_idx" ON "CashMovement"("occurredAt");

ALTER TABLE "CashWallet" ADD CONSTRAINT "CashWallet_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashWallet" ADD CONSTRAINT "CashWallet_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashWallet" ADD CONSTRAINT "CashWallet_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_fromWalletId_fkey" FOREIGN KEY ("fromWalletId") REFERENCES "CashWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_toWalletId_fkey" FOREIGN KEY ("toWalletId") REFERENCES "CashWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
