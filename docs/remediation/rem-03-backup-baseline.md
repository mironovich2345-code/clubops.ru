# REM-03 — Off-site Backup & Proven Restore — Baseline

Third remediation task. Goal: regular **off-site** PostgreSQL backups (independent of deploy) with a
**proven restore**, measured RPO/RTO, and a backup/restore release gate. Additive only — no destructive
restore over production, no auto-switch to a restored DB, no schema reset, no deletion of existing backups,
no financial-data/RBAC/business-logic change, no Company hard-delete, no tenant repair.

## Audited baseline
- **HEAD:** `5f2a866` · **branch:** `main` · **vs origin:** 14 ahead (REM-01/02 unpushed) · **tree:** clean.
- **tsc:** clean. **prisma:** dev+prod valid. **pilot:full:** 3913/0 across 88 suites. **build:prod:** compiles (BUILD_EXIT=0).

## Sandbox capability (honest)
- `@aws-sdk/client-s3`: **present** (usable for S3 upload). `@aws-sdk/lib-storage`: absent (multipart is a future enhancement; PutObject suffices for beta dump sizes).
- **`pg_dump`: NOT available. `docker`: NOT available. S3/MinIO/LocalStack: NOT available.**
- ⇒ the real **PostgreSQL backup + restore rehearsal and the off-site S3 upload/download are NOT EXECUTABLE here**. They are shipped as tooling + precise runbooks and marked **NOT EXECUTED**; **OPS-001 stays PARTIALLY CLOSED** until run on a real PostgreSQL + S3 (the mandatory gate `G-BACKUP-3/4`).

## Deployment targets
- **VM / Compose (canonical):** `deploy/deploy.sh` — pre-deploy `pg_dump -Fc` into `/opt/club-ops/backups` (`BACKUP_DIR`, `KEEP_BACKUPS=7`), local-only, on deploy only.
- **Railway / plain docker run:** `docker-entrypoint.sh` migrate-on-start; no backup.

## Current backup model (the OPS-001 risk)
| Aspect | Current |
|---|---|
| Trigger | **deploy only** (systemd digest gate) — not scheduled |
| Location | `/opt/club-ops/backups` **on the same VM disk** as the postgres volume |
| Off-site | **none** | Encryption | none (chmod 600 only) |
| Retention | 7 local dumps | Restore tested | **never** |
| RPO | = time since last deploy (unbounded) | RTO | **unknown** |

A VM/disk/region loss destroys the DB **and** all backups. See `rem-03-current-backup-risk.md`.

## Open OPS findings in scope
OPS-001 (co-located, unproven backup), OPS-016 (no tenant-scoped restore/export), DATA-008 (Company
hard-delete recovery), OPS-013 (DATABASE_URL validation — closed for the backup tooling here).

## Scope delivered here
Provider-neutral off-site backup + restore tooling (env contract, pg_dump core, SHA-256, manifest with
critical money checksums, S3 upload + remote verify, lock, dry-run, retention, safe failure), a restore
tool with a production-target guard, `backup:list`, deploy integration (additive), real executable tests
for the non-PG/non-S3 logic, and runbooks. The **real PostgreSQL restore + S3 rehearsal remain the
mandatory gate** (NOT EXECUTED in this sandbox).
