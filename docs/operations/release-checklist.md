# CLUB-OPS — Pre-Deploy Release Checklist

Mandatory gate before a production deploy. Items marked **[BLOCKER]** must pass. At `dc14d10` several
blockers are **not yet satisfiable** (backup restore unproven, readiness endpoint absent) — see notes.

## Code & tests
- [ ] Clean git tree; release commit tagged; baseline recorded.
- [ ] `tsc --noEmit` clean.
- [ ] `prisma validate` dev + prod valid.
- [ ] `pilot:full` green (record count/suites).
- [ ] `build:prod` compiles **and the dev Prisma client is regenerated afterward** (ARCH-013) if the same host runs dev pilots.

## Data & migrations
- [ ] **[BLOCKER]** Staging migration rehearsal passed (`staging-migration-rehearsal.md`): migrate deploy OK, row counts + money checksums unchanged, no long write-lock. *(NOT EXECUTED in sandbox — run on staging.)*
- [ ] `audit:data-integrity` on a prod read replica — no new S0/S1.
- [ ] `audit:financial-reconciliation` on a prod read replica — no new violations.
- [ ] Migration reviewed against `migration-risk-register.md` (additive; any index on a large table is `CONCURRENTLY`).

## Backup & recovery
- [ ] **[BLOCKER]** A **verified-restorable** backup exists (`pg_dump -Fc`), taken immediately before deploy, **and** an off-site copy. *(Today: local-only, restore unproven — OPS-001.)*
- [ ] Restore evidence on file (last successful restore rehearsal date). *(Today: none.)*
- [ ] **[BLOCKER]** File blobs durable: `STORAGE_PROVIDER=s3` + `STORAGE_S3_*` set (prod **fails fast** on `local` — REM-04/ARCH-017), off-site file manifest scheduled (`backup:files-manifest`), inventory clean (`audit:file-inventory`). *(Real S3 upload/download/restore rehearsal = G-FILE-1..8; OPS-002 PARTIALLY CLOSED until proven.)*
- [ ] **[BLOCKER]** `/api/health/ready` = 200 on the new image BEFORE traffic is switched (REM-06 — DB + schema/migration + provider + storage). `deploy.sh` enforces the two-stage live→ready gate. `npm run audit:readiness --production` on the target env = no fatals. *(Real DB-down proof = G-READY-3..8/12 staging gate.)*
- [ ] Rollback image digest recorded (previous `:main`).

## Config & infra
- [ ] Env validated: all prod-required secrets present (fail-closed) — `environment-secrets-register.md`.
- [ ] **[BLOCKER]** `STORAGE_PROVIDER=s3` in production (files durable) — confirm via `/api/health` `storage` field (OPS-002).
- [ ] `DATABASE_URL` is a real `postgres://` URL (OPS-013 — a malformed one silently degrades to sqlite).
- [ ] `CRON_SECRET` set (OFD cron) — note it's missing from the deploy env example (OPS-011).

## Health & ownership
- [ ] Health/readiness: liveness green; **readiness (DB) check present** — *(Today: no readiness endpoint — OPS-003.)*
- [ ] Deploy owner assigned; acceptance owner assigned.
- [ ] Post-deploy checklist ready (`post-deploy-checklist.md`).

## Current blocker status (honest)
At `dc14d10` the **[BLOCKER]** items for **proven restore**, **readiness endpoint**, and **enforced S3
in prod** are **not met**. Per this audit's stance, a production deploy of real financial data should
wait until OPS-001/002/003 are closed (see `remediation-backlog-after-audit-04.md`).
