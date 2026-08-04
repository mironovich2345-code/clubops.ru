// REM-06 — production startup fail-fast. Next.js calls register() ONCE when the
// server process starts (NOT during `next build`). In production we refuse to start
// on a fatal config: a mis-shaped/SQLite/missing DATABASE_URL, a missing SESSION_SECRET,
// or an invalid storage config (REM-04). Transient conditions (DB down, pending
// migration) are NOT fatal here — they surface as /api/health/ready = not_ready.
//
// The `process.env.NEXT_RUNTIME === "nodejs"` guard is the documented pattern that
// keeps the node-only storage/health modules (which import node:fs) OUT of the edge
// instrumentation bundle at build time.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertProductionStartup } = await import("@/lib/health/startup-validation");
    const { assertStorageConfigured } = await import("@/lib/storage");
    // These throw (secret-free) only in production on a fatal condition, aborting startup.
    assertStorageConfigured();
    assertProductionStartup();
  }
}
