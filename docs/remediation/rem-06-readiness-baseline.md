# REM-06 — Readiness Baseline

Read-only assessment before any REM-06 change.

## Git / build baseline
| Aspect | Value |
|---|---|
| HEAD | `da879d6` |
| Branch | `main` |
| Working tree | clean |
| tsc | 0 errors |
| prisma dev / prod | valid |
| pilot:full | 4014/0 across 91 suites (REM-05 gauntlet) |
| build:prod | compiles |

## Current `/api/health` (as-is)
- **Liveness only**: `src/app/api/health/route.ts` returns `{status:"ok", ...deploymentVersion,
  storage, email, ai, telegram, ofd}` with **no DB call** (ARCH-015). Strict key whitelist enforced
  by `pilot-health` (`commit,deploymentId,email,environment,service,status,storage,time`).
- Used by: Dockerfile HEALTHCHECK, `deploy/docker-compose.prod.yml`, `docker-compose.production.yml`,
  `deploy.sh` internal + external probes. **All gate on liveness only → traffic can reach an app whose
  DB is down (OPS-003).**

## Startup flow (as-is)
- No `instrumentation.ts`; no central startup validation. Secrets fail closed lazily on first use
  (`env-secrets.ts`). `STORAGE_PROVIDER` fail-fast added in REM-04 (`assertStorageConfigured`), not yet
  wired to a startup hook.
- `DATABASE_URL` is NOT validated at startup — a malformed URL or a sqlite URL in production is only
  discovered at first query (OPS-013). Prisma client target vs environment is order-dependent
  (ARCH-013/OPS-004).

## Storage readiness (REM-04)
- `src/lib/storage/readiness.ts` — `storageReadiness()` (config) + `probeStorage()` (bounded), built
  but not yet consumed by any endpoint.

## Deploy / Railway / Compose (as-is)
- `railway.json` — no `healthcheckPath` (Railway default). Compose healthchecks → `/api/health`.
  `deploy.sh` polls `/api/health` (liveness) then accepts the image.

## Monitoring hooks
- `docs/operations/monitoring-alerts.md` + REM-03 backup alerts + REM-04 file alerts exist; no
  readiness/dependency alert matrix.

## Findings in scope
- **ARCH-015** — health is liveness-only. **OPS-003** — traffic to a DB-less app. **OPS-013** —
  DATABASE_URL unvalidated / sqlite-in-prod. **ARCH-013/OPS-004** — Prisma client/provider mismatch.

## No-PostgreSQL sandbox constraint
This sandbox has no PostgreSQL. The real provider/migration readiness proof (DB down→ready=false→
recover, pending-migration, provider mismatch on a prod client) is the **staging gate**
(`docs/testing/rem-06-postgres-readiness-rehearsal.md`). Logic is proven here with mock-client tests
(`test:rem-06-readiness` 28/28).
