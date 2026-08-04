# REM-06 — Readiness Design

`src/lib/health/readiness.ts` — `computeReadiness(client = prisma)` → `{ status, ready, checks[] }`.

## Required checks (all must not be `failed`)
1. **database_url** — `validateDatabaseEnvironment` (config-level, no I/O).
2. **storage** — `storageReadiness()` (REM-04); required in production, `degraded` in dev.
3. **database** — bounded `SELECT 1` (`checkDatabase`, 3s timeout, no writes).
4. **schema_migrations** — `checkSchemaCompatibility` (read-only `_prisma_migrations`): failed/pending →
   `failed`; newer-than-expected → `degraded` (does not block).
5. **prisma_provider** — `detectDbProvider` vs `expectedDbProvider`; `unknown` does not block (never
   fabricate a mismatch we can't prove).

`ready = required checks.every(status !== "failed")`. `degraded`/`unknown` do not block.

## Migration compatibility (§8)
`migration-manifest.ts` pins `EXPECTED_LATEST_MIGRATION`. The DB missing it → `pending_migration`
(not_ready). A rolled-back / started-not-finished row → `failed_migration`. A strictly-newer applied
migration → `newer_schema` (forward-compatible warn). **The endpoint never applies migrations.**

## Caching (§12)
`createProbeCache(ttlMs, run)` — short TTL (readiness 2s, dependencies 5s) + single-flight so a probe
storm hits one real check. A cached FAILURE only lives for its TTL — it never sticks as success after a
dependency recovers (proven: `test:rem-06-readiness` 21).

## Failure scenarios (proven with mock clients)
| Scenario | live | ready |
|---|---|---|
| DB down | 200 | 503 (`DB_UNREACHABLE`) |
| DB recovers | 200 | 200 (no restart) |
| pending migration | 200 | 503 (`pending_migration`) |
| failed migration | 200 | 503 (`failed_migration`) |
| provider mismatch | 200 | 503 (`PROVIDER_MISMATCH`) |
| storage down (prod) | 200 | 503 |
| malformed/sqlite URL (prod) | startup fails fast | — |

## Optional integrations (§10)
SMTP/AI/OFD/backup/scheduler are `degraded`, never `requiredForReadiness` — one being down limits a
feature, never takes the whole app out of rotation (`dependencies.ts`).
