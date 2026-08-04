# REM-06 — Readiness Live Acceptance Checklist

Automated proof done (`test:rem-06-readiness` 28/28; `pilot:rem-06-readiness`). Live gates:

- [ ] **G-READY-1** Production refuses to start on a sqlite `DATABASE_URL` (startup fail-fast).
- [ ] **G-READY-2** A malformed `DATABASE_URL` blocks startup with a safe code (no URL/password leak).
- [ ] **G-READY-3** DB down → `/live` = 200, `/ready` = 503 (`not_ready`); traffic stops.
- [ ] **G-READY-4** DB recovers → `/ready` = 200 (no manual restart).
- [ ] **G-READY-5** A pending migration → `/ready` = 503 (`pending_migration`); no business traffic.
- [ ] **G-READY-6** Storage down in production → `/ready` = 503; no local fallback.
- [ ] **G-READY-7** No silent local storage fallback in production (REM-04 + readiness).
- [ ] **G-READY-8** Deploy waits for `/ready` before switching traffic; aborts + rolls back on failure.
- [ ] **G-READY-9** Railway `healthcheckPath` + Compose healthchecks point to `/api/health/ready`.
- [ ] **G-READY-10** `/dependencies` exposes no host/credential/bucket/DB name/path/stack.
- [ ] **G-READY-11** `deploymentVersion` in the response matches the deployed commit.
- [ ] **G-READY-12** Real PostgreSQL gate (`rem-06-postgres-readiness-rehearsal.md`) passes on staging.

**Sign-off:** ARCH-015 + OPS-003 close on live/ready separation + the deploy gate + G-READY-3..8.
OPS-013 closes for startup on G-READY-1/2. ARCH-013/OPS-004 close on G-READY-12 (real prod-client
provider proof). Until the staging PostgreSQL gate passes, provider/migration compatibility is proven
by logic tests only (PARTIAL).
