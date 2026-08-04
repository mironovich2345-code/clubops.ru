// REM-06 — the migration the running app EXPECTS to be applied. Updated whenever a
// new migration ships (it is the newest dir in prisma/migrations). Readiness uses it
// to detect a DB that is BEHIND the app (pending migration → not_ready) without the
// health endpoint ever applying anything. A build step may regenerate this; today it
// is a reviewed constant.
export const EXPECTED_LATEST_MIGRATION = "20260804120000_rem04_file_durability_metadata";
export const EXPECTED_MIGRATION_COUNT = 79;
