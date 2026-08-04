# REM-06 — Deploy / Railway / Compose Integration

## Target deploy flow (§14)
1. Build image (prod Prisma client baked). 2. Validate env contract (`audit:readiness`). 3. Off-site
pre-deploy backup gate (REM-03, aborts on failure). 4. Apply migrations (one-shot, outside the app).
5. Start app. 6. Poll `/api/health/live` (process up). 7. Poll `/api/health/ready` (DB+schema+storage).
8. **Only then** accept/switch traffic. 9. Post-deploy smoke. 10. Record `deploymentVersion`. On ready
failure → deploy fails + app rolls back to the previous image (DB rollback only via the runbook, never
automatic).

## `deploy.sh`
Two-stage gate: waits for `/api/health/live`, then requires `/api/health/ready` before writing the
STATE_FILE / accepting the new image. A live-but-not-ready app (DB down / pending migration) is never
switched in (OPS-003). Rollback-to-previous-image on failure is unchanged. External HTTPS probe →
`/ready`.

## Dockerfile + Compose
- `Dockerfile` HEALTHCHECK → `/api/health/ready` (Node http probe, no wget).
- `deploy/docker-compose.prod.yml` + `docker-compose.production.yml` app healthcheck → `/api/health/ready`.
- App still `depends_on` postgres `service_healthy`, so the DB is up before readiness is polled.

## Railway (§15)
`railway.json` → `deploy.healthcheckPath = /api/health/ready` (+ timeout). Railway routes traffic only
when ready. Migrations must run as a release/one-shot step BEFORE readiness passes (a pending migration
→ ready=false). Concurrent migrate+app across replicas must be avoided (single migrate step) — noted for
the platform config.

## Migration-before-ready ordering
Because readiness returns `not_ready` on a pending migration, the deploy MUST apply migrations before
(or as) the app is brought into rotation; otherwise the healthcheck never turns green. This is the
correct fail-safe: no traffic on a schema the app doesn't expect.

## Staging gate
The real PostgreSQL flow (DB down→ready=false→recover; pending-migration→ready=false→apply→ready=true;
prod-client provider match) is `docs/testing/rem-06-postgres-readiness-rehearsal.md` — NOT EXECUTED in
the sandbox (no PostgreSQL).
