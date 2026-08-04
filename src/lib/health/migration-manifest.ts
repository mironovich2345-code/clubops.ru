// REM-06 — the migration the running app EXPECTS to be applied. Updated whenever a
// new migration ships (it is the newest dir in prisma/migrations). Readiness uses it
// to detect a DB that is BEHIND the app (pending migration → not_ready) without the
// health endpoint ever applying anything. A build step may regenerate this; today it
// is a reviewed constant.
export const EXPECTED_LATEST_MIGRATION = "20260805120000_rem07_security_event";
export const EXPECTED_MIGRATION_COUNT = 80;
