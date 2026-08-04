// REM-06 — schema/migration compatibility (spec §8). Read-only: the health endpoint
// DIAGNOSES, it never applies migrations. Reads `_prisma_migrations` and decides:
//   - failed migration (rolled back / started-not-finished) → not compatible;
//   - the app's EXPECTED_LATEST_MIGRATION not applied → pending (not_ready);
//   - a NEWER-than-expected schema → warn (explicit compatibility policy).

import { EXPECTED_LATEST_MIGRATION } from "./migration-manifest";

type RawClient = { $queryRawUnsafe: (sql: string) => Promise<unknown> };

export type SchemaCompatibility = {
  compatible: boolean;
  code: "ok" | "no_migrations_table" | "failed_migration" | "pending_migration" | "newer_schema" | "probe_error";
  appliedCount: number | null;
  latestApplied: string | null;
  expectedLatest: string;
};

type MigrationRow = { migration_name: string; finished_at: unknown; rolled_back_at: unknown };

/** Read-only migration compatibility check. Never writes; never applies migrations. */
export async function checkSchemaCompatibility(prisma: RawClient): Promise<SchemaCompatibility> {
  const expectedLatest = EXPECTED_LATEST_MIGRATION;
  let rows: MigrationRow[];
  try {
    rows = (await prisma.$queryRawUnsafe(
      "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name ASC",
    )) as MigrationRow[];
  } catch {
    return { compatible: false, code: "no_migrations_table", appliedCount: null, latestApplied: null, expectedLatest };
  }

  const failed = rows.find((r) => r.rolled_back_at != null || r.finished_at == null);
  if (failed) {
    return { compatible: false, code: "failed_migration", appliedCount: rows.length, latestApplied: failed.migration_name, expectedLatest };
  }

  const applied = rows.map((r) => r.migration_name);
  const latestApplied = applied.length ? applied[applied.length - 1] : null;

  if (!applied.includes(expectedLatest)) {
    // The DB is missing a migration the app ships → pending (unless the DB is AHEAD).
    const code: SchemaCompatibility["code"] = latestApplied && latestApplied > expectedLatest ? "newer_schema" : "pending_migration";
    return { compatible: code === "newer_schema", code, appliedCount: rows.length, latestApplied, expectedLatest };
  }

  // Expected migration present + finished. A strictly-newer applied migration is a
  // forward-compatible warn, not a failure.
  if (latestApplied && latestApplied > expectedLatest) {
    return { compatible: true, code: "newer_schema", appliedCount: rows.length, latestApplied, expectedLatest };
  }
  return { compatible: true, code: "ok", appliedCount: rows.length, latestApplied, expectedLatest };
}
