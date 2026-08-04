# REM-06 — Database Readiness, Startup Validation, Dependency Health & Safe Traffic Gating — Final Report

**1. Baseline commit:** `da879d6` (tsc 0 · pilot:full 4014/0 · schemas valid · build:prod compiles).
Additive only; no financial formula / RBAC / tenant / payroll / cash / invoice / refund / file-auth /
data-migration change; no automatic production deploy or data change.

**2. Previous health behavior.** One `/api/health` = **liveness only** (no DB) used by every deploy
healthcheck → traffic could reach a DB-less app (ARCH-015/OPS-003); no startup validation; `DATABASE_URL`
unvalidated (OPS-013); Prisma client/provider order-dependent (ARCH-013/OPS-004).

**3. New contract.** `/api/health/live` (liveness), `/api/health/ready` (traffic gate, 503 when not
ready), `/api/health/dependencies` (sanitized diagnostics); `/api/health` kept verbatim as the liveness
alias (backward compatible).

**4. DATABASE_URL validation.** Pure `validateDatabaseEnvironment` — production refuses sqlite/file:/
empty/malformed/unsupported/localhost(unless override) + provider mismatch; only protocol + host-CLASS
derived; value/password never returned or logged (closes OPS-013 for startup).

**5. Prisma provider validation.** `detectDbProvider` (`sqlite_version()` vs `version()`) vs
`expectedDbProvider`; a mismatch → not_ready. The mechanism is shipped + unit-proven; the real
prod-client proof is the staging gate (ARCH-013/OPS-004).

**6. Startup classification.** `classifyStartup` → FATAL (sqlite/malformed/missing DATABASE_URL, missing
SESSION_SECRET, invalid storage) / NOT-READY (DB down, pending/failed migration) / DEGRADED (SMTP/AI/
OFD/backup). `assertProductionStartup` (via `src/instrumentation.ts`) aborts a production start on FATAL.

**7. DB readiness.** Bounded `SELECT 1` (3s timeout, no writes).

**8. Migration compatibility.** Read-only `_prisma_migrations` check vs `EXPECTED_LATEST_MIGRATION`:
pending/failed → not_ready; newer → degraded. The endpoint never applies migrations.

**9. Storage readiness.** REM-04 `storageReadiness()` integrated — required in production, `degraded`
(local ok) in dev.

**10. Optional integrations.** SMTP/AI/OFD/backup/scheduler = `degraded`, never blocking.

**11–13. Deploy / Railway / Compose.** `deploy.sh` two-stage gate (live → ready before accepting;
rollback on failure); Dockerfile + both compose healthchecks + `railway.json healthcheckPath` →
`/api/health/ready`. Migrations must run before ready turns green (fail-safe).

**14. Failure scenarios.** DB-down / recover / pending / failed-migration / provider-mismatch / storage-
down / malformed-URL — all proven (`test:rem-06-readiness` 28/28 with mock Prisma clients).

**15. Logging/monitoring.** Transition-only logging (ready↔not_ready, ok↔degraded) with deploymentVersion
+ safe code; alert matrix in `dependency-health-runbook.md` (pager/warning/informational).

**16. CLI.** `audit:readiness` (read-only, jiti, reuses the real validators; `--json`/`--production`;
secrets redacted).

**17. Integration tests.** `test:rem-06-readiness` **28/28**.

**18. PostgreSQL gate result — NOT EXECUTED** (no PostgreSQL in the sandbox). Gate:
`rem-06-postgres-readiness-rehearsal.md` (DB down→ready=false→recover; pending→ready=false→apply→true;
prod-client provider match).

**19. Storage gate result — NOT EXECUTED** (no S3). Gate: §C of the rehearsal (S3 down → ready=false,
no local fallback).

**20. Findings closure.** **ARCH-015 CLOSED** (live/ready separation + deploy traffic gate). **OPS-003
PARTIALLY CLOSED** (readiness + deploy gate shipped & unit-proven; real DB-down staging proof = G-READY-
3..8/12). **OPS-013 CLOSED for app startup** (production DATABASE_URL validation + startup fail-fast).
**ARCH-013 / OPS-004 PARTIALLY CLOSED** (URL/expected validation + provider-detect mechanism; real
prod-client mismatch proof = G-READY-12).

**21. Pilot / full / build.** `pilot:rem-06-readiness` **32/32** · pilot:full **4046/0 across 92 suites**
· tsc 0 · build:prod **compiles (BUILD_EXIT=0)** — all four health routes emitted (`/api/health`, `/live`,
`/ready`, `/dependencies`); `test:rem-06-readiness` **28/28**; dev Prisma client restored after the prod
build. (Instrumentation uses the `NEXT_RUNTIME === "nodejs"` guard so the node-only startup checks stay
out of the edge bundle.)

**22. Commit hashes.** health lib+endpoints+startup · deploy migration · CLI · tests · pilot+docs+report
(on `main`).

**23. Open live gates.** G-READY-1..12 — esp. G-READY-3..8 (DB/storage down → not_ready, deploy waits),
G-READY-12 (real PostgreSQL).

**24. What remains.** Run the staging PostgreSQL + storage rehearsals; then OPS-003 + ARCH-013/OPS-004
close fully. Next candidate: REM-07 (log denied authorization + request id — OPS-006/SEC-009).

## Definition of Done
- live/ready separated — ✅
- DB + storage required for ready — ✅ (storage prod-required)
- production SQLite impossible — ✅ (startup fail-fast + readiness)
- malformed DATABASE_URL blocks startup — ✅
- Prisma provider mismatch detected — ✅ (mechanism; real proof = gate)
- pending migration blocks traffic — ✅ (readiness 503)
- optional integrations degrade, not outage — ✅
- deploy waits for ready — ✅ (deploy.sh + healthchecks + railway)
- production data unchanged — ✅
- staging PostgreSQL gate before go-live — ⛔ NOT EXECUTED (documented gate; no PG in sandbox)
- build + pilots green — ✅ (gauntlet step)

The honest gap: **provider/migration/DB-down behavior is proven with mock clients (28/28), not real
PostgreSQL** — this sandbox has none. The endpoints, deploy gate and startup fail-fast are shipped; the
real-DB proof is `rem-06-postgres-readiness-rehearsal.md`. **OPS-003 and ARCH-013/OPS-004 stay PARTIALLY
CLOSED** until that staging gate passes.
