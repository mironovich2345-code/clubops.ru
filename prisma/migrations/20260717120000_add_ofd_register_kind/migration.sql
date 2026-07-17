-- Non-destructive: add registerKind to OfdCashRegisterMapping.
-- Existing rows fall back to 'club_cashbox' via the column default.
ALTER TABLE "OfdCashRegisterMapping" ADD COLUMN "registerKind" TEXT NOT NULL DEFAULT 'club_cashbox';
