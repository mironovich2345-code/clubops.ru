# REM-06 — Health Contract

Three separated endpoints. `/api/health` stays as the **liveness alias** (unchanged) for backward
compatibility.

## `/api/health/live` — liveness
Process is up + deployment metadata. **No** DB/S3/SMTP/AI/OFD. Never flaps during migrations/reconnects.
```json
{ "status": "alive", "commit": "...", "deploymentId": "...", "environment": "...", "timestamp": "..." }
```
Always HTTP 200 while the process serves.

## `/api/health/ready` — readiness (traffic gate)
Required checks: env contract (DATABASE_URL) · DB connection · schema/migration compatibility · Prisma
provider match · storage readiness (production). Any required **failed** → **HTTP 503**,
`status:"not_ready"`; the load balancer / orchestrator stops routing traffic.
```json
{ "status": "ready|not_ready", "commit": "...", "timestamp": "...", "checks": [ { "name":"database","status":"ok","requiredForReadiness":true,... } ] }
```
Checks are secret-free (codes/metadata only). Cached (2s TTL) + single-flight; a cached failure never
sticks as success.

## `/api/health/dependencies` — diagnostics
Readiness checks + optional integrations (SMTP/AI/OFD/backup/scheduler) as `degraded`. Always HTTP 200
(diagnostic surface, not a gate). Sanitized — no hosts/credentials/bucket-or-DB names/paths/stacks.

## Backward compatibility (§3)
- `/api/health` is preserved verbatim (liveness alias) — the existing `pilot-health` key contract holds.
- Deploy tooling (Dockerfile, both compose files, `deploy.sh`, `railway.json`) is migrated to
  `/api/health/ready`, so the old "liveness-only" gate no longer decides traffic.

## Status model (`src/lib/health/types.ts`)
`DependencyCheckResult { name, status: ok|degraded|failed|unknown, requiredForReadiness, latencyMs,
checkedAt, errorCode?, safeMessage?, metadata? }`. No raw errors ever reach an API response.
