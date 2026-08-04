# REM-06 — Database & Provider Validation

`src/lib/health/database-validation.ts` — `validateDatabaseEnvironment(env, {isProduction,
allowLocalhost})`. PURE; the full `DATABASE_URL` and its password NEVER leave the function.

## Rules
| Condition | Result |
|---|---|
| empty `DATABASE_URL` | `DATABASE_URL_EMPTY` |
| non-postgres/sqlite/mysql protocol | `DATABASE_URL_UNSUPPORTED_PROTOCOL` |
| postgres URL that doesn't parse / no host | `DATABASE_URL_MALFORMED` |
| **production + sqlite/file:** | `PRODUCTION_SQLITE_FORBIDDEN` |
| production + provider ≠ expected | `PROVIDER_MISMATCH:<got>!=<want>` |
| production + localhost (no override) | `PRODUCTION_LOCALHOST_FORBIDDEN` |
| dev + non-sqlite | warning only |

Returns `{ ok, provider, expectedProvider, hostClass (localhost/private/public/file/unknown), errors,
warnings }`. `expectedDbProvider(isProduction)` = `postgresql` (prod) / `sqlite` (dev). Only the protocol
and host CLASS are derived; the value is never returned or logged (closes **OPS-013** for startup).

## Provider match at runtime (ARCH-013 / OPS-004)
`detectDbProvider(prisma)` runs `SELECT sqlite_version()` then `SELECT version()` to learn what the LIVE
DB actually speaks, and readiness compares it to `expectedDbProvider`. This catches a `build:prod` that
left the dev (sqlite) client, or a prod client pointed at the wrong DB. Full proof needs a real
PostgreSQL client → staging gate (`rem-06-postgres-readiness-rehearsal.md`); the URL/expected checks and
the detection mechanism are proven by `test:rem-06-readiness`.

## Startup fail-fast
`assertProductionStartup()` (`startup-validation.ts`) is called from `src/instrumentation.ts` when the
Node server starts (never during `next build`). In production a fatal config — sqlite/malformed/empty/
mismatch DATABASE_URL, missing `SESSION_SECRET`, invalid storage — aborts startup with a secret-free
message. Transient conditions (DB down, pending migration) are NOT fatal — they surface as
`/api/health/ready = not_ready`.
