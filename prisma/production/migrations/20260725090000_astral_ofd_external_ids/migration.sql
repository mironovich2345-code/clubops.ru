-- Non-destructive additive migration (production PostgreSQL) — Astral.ОФД external
-- identifiers + sync diagnostics. Only ADD COLUMN / CREATE INDEX; no ALTER TYPE, no
-- DROP, no rebuild. Existing Taxcom rows are untouched (all columns nullable/default).

-- OfdConnection: selected Astral organization + optional import start boundary.
ALTER TABLE "OfdConnection" ADD COLUMN "externalOrganizationId" TEXT;
ALTER TABLE "OfdConnection" ADD COLUMN "syncStartDate" TIMESTAMP(3);

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
