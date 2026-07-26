-- Non-destructive additive migration (production PostgreSQL) — calculation engine
-- marker for the role-categories v2 engine. Existing rows default to legacy_v1.
-- Only ADD COLUMN; no ALTER TYPE, no DROP, no rebuild, no recompute.
ALTER TABLE "PayrollCalculation" ADD COLUMN "calculationEngineVersion" TEXT NOT NULL DEFAULT 'legacy_v1';
