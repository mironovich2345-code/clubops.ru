-- Additive-only (SQLite dev): Astral.ОФД external identifiers + sync diagnostics.
-- No DROP, no table rebuild — every column is nullable or has a default, so existing
-- Taxcom rows are untouched and keep behaving exactly as before.

-- OfdConnection: selected Astral organization + optional import start boundary.
ALTER TABLE "OfdConnection" ADD COLUMN "externalOrganizationId" TEXT;
ALTER TABLE "OfdConnection" ADD COLUMN "syncStartDate" DATETIME;

-- OfdCashRegisterMapping: Astral org/outlet/KKT external ids (Taxcom leaves null).
ALTER TABLE "OfdCashRegisterMapping" ADD COLUMN "externalOrganizationId" TEXT;
ALTER TABLE "OfdCashRegisterMapping" ADD COLUMN "externalAliasId" TEXT;
ALTER TABLE "OfdCashRegisterMapping" ADD COLUMN "externalKktId" TEXT;

-- OfdSyncRun: sync diagnostics (default 0 / null; safe for Taxcom too).
ALTER TABLE "OfdSyncRun" ADD COLUMN "pagesProcessed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OfdSyncRun" ADD COLUMN "documentsReceived" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OfdSyncRun" ADD COLUMN "unknownDocuments" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OfdSyncRun" ADD COLUMN "durationMs" INTEGER;

-- Lookup KKT mappings by Astral external KKT id.
CREATE INDEX "OfdCashRegisterMapping_provider_externalKktId_idx" ON "OfdCashRegisterMapping"("provider", "externalKktId");
