-- Additive-only (SQLite dev): calculation engine marker for the role-categories v2
-- engine. Existing rows default to legacy_v1 — no recompute, no rebuild, no DROP.
ALTER TABLE "PayrollCalculation" ADD COLUMN "calculationEngineVersion" TEXT NOT NULL DEFAULT 'legacy_v1';
