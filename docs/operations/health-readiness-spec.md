# CLUB-OPS — Health / Readiness Spec (ARCH-015 / OPS-003)

Read-only assessment at `dc14d10`. Current `GET /api/health` is **liveness only**.

## Current `/api/health` (src/app/api/health/route.ts)
Returns 200 + `status:"ok"` + deploymentVersion (commit/deploymentId/environment) + provider readiness
**names only** (storage `local|s3`, email configured?, ai requested/effective/policy, telegram, ofd).
**Intentionally makes NO database call** (comment: "does not flap while migrations run"),
`Cache-Control: no-store`, `force-dynamic`. Docker HEALTHCHECK and the VM deploy gate (`deploy.sh:229`)
both treat 200 as healthy.

## The three concepts (currently conflated)
| Concept | Should check | Current |
|---|---|---|
| **Liveness** | process is up + serving HTTP | ✅ `/api/health` |
| **Readiness** | can serve real traffic — **DB reachable + schema compatible** | ❌ **missing** |
| **Dependency health** | storage/AI/OFD/SMTP degraded (informational) | ⚠️ names only, not probed |

## The gap (OPS-003)
Because health never touches the DB, **an app that cannot reach Postgres (bad `DATABASE_URL`, DB down,
migrations mid-apply) still returns 200 and receives traffic** → users hit 500s while the LB thinks the
app is healthy. The deploy gate can also mark a broken deploy "healthy."

## Recommended split (NOT implemented here)
- **Keep** `/api/health` as **liveness** (no DB) — correct for "don't flap during migrations."
- **Add** `/api/health/ready` = **readiness**: a cheap `SELECT 1` (+ optional `_prisma_migrations` head check) → 200 only when the DB is reachable. Use **readiness** for LB traffic gating and the deploy health check; keep **liveness** for the container restart policy.
- **Dependency health** (storage write-test, AI/OFD/SMTP): report as `degraded` fields, **never** block traffic — a down AI provider must not take the app offline. Alert on degraded (see `monitoring-alerts.md`), don't fail readiness.

## What must gate traffic vs. only degrade vs. only alert
| Signal | Gate traffic? | Degrade? | Alert? |
|---|---|---|---|
| Process down | yes (liveness) | — | yes |
| DB unreachable / schema incompatible | **yes (readiness)** | — | yes |
| Storage unwritable | no (degrade) | yes | yes |
| AI/OFD/SMTP down | no | yes | yes (OFD stale = P1) |
| Background jobs not running | no | yes | yes |

## Update (REM-06) — IMPLEMENTED
The split is shipped: `/api/health/live` (liveness), `/api/health/ready` (traffic gate — env +
`SELECT 1` + `_prisma_migrations` compatibility + Prisma provider match + storage), `/api/health/
dependencies` (sanitized diagnostics). `/api/health` is kept verbatim as the **liveness alias**.
Deploy/Railway/Compose healthchecks + `deploy.sh` (two-stage live→ready) now gate on `/ready`. Startup
fail-fast (`src/instrumentation.ts`) refuses a production start on a fatal config (sqlite/malformed
DATABASE_URL, missing SESSION_SECRET, invalid storage). `DATABASE_URL` is validated (OPS-013 CLOSED for
startup). **Refinement vs the original recommendation:** storage is **required-for-readiness in
PRODUCTION** (no silent local fallback — REM-04), `degraded` in dev; SMTP/AI/OFD/backup stay degrade-only.
Logic proven by `test:rem-06-readiness` (28/28); the real PostgreSQL/S3 proof is
`docs/testing/rem-06-postgres-readiness-rehearsal.md` (NOT EXECUTED in sandbox). See
`docs/remediation/rem-06-final-report.md`. ARCH-015 CLOSED; OPS-003 + ARCH-013/OPS-004 PARTIALLY CLOSED
(staging gate).
