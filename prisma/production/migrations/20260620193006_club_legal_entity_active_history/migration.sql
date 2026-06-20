-- Additive: per-association active flag + history timestamp on ClubLegalEntity.
-- Existing rows default to isActive=true (current active association) with a
-- NULL deactivatedAt. No data is removed; no association is closed by this
-- migration.
ALTER TABLE "ClubLegalEntity" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClubLegalEntity" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
