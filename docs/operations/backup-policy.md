# CLUB-OPS — Backup Policy (as-is + gaps)

Read-only assessment at `dc14d10`. **A backup file is not a backup until a restore is proven.**

## Current state (from `deploy/deploy.sh`)
| Aspect | Current |
|---|---|
| DB backup | `pg_dump -Fc` (custom format) of the postgres DB, **only inside `deploy.sh` before each deploy** (`:200`) |
| Trigger | on **deploy** (systemd timer detects a new image digest); **not scheduled independently** |
| Abort safety | deploy aborts if backup fails or is empty (`:203,206`) — good |
| Retention | last **7** dump files (`KEEP_BACKUPS=7`, `:209`) |
| Location | `${DEPLOY_DIR}/backups` = `/opt/club-ops/backups` — **on the same VM / same disk as the postgres volume** |
| Encryption | none (files are `chmod 600`, root-only, but not encrypted at rest) |
| Off-site copy | **none** (no S3/rclone/restic/scp — confirmed `storage-risk`/`deploy-readiness` scan) |
| Uploaded files backup | **none** — local storage is not dumped; S3 (if used) relies on the bucket's own durability |
| Config/secrets backup | `.env` on the VM only; not backed up |
| Migration metadata | in the DB (`_prisma_migrations`) → included in the `pg_dump` |
| Deployment commit | recorded in `STATE_FILE` on the VM only |
| Last successful backup | **unknown** (no monitoring; see `monitoring-alerts.md`) |
| Restore test date | **never** (no evidence of an executed restore — see `backup-restore-rehearsal.md`) |
| RPO | **= time since the last deploy** (could be days/weeks if no deploys) — **not a fixed RPO** |
| RTO | **unknown** (restore never timed) |

## Findings (feed OPS-001)
1. **Backups are co-located with the database** (same VM/disk). A VM loss, disk failure, or region loss destroys the DB **and** all 7 backups simultaneously → **total data loss**. This is the single largest operational risk.
2. **Backups only happen on deploy.** A stable period with no deploys means **no fresh backup** — RPO grows unbounded. There is no daily scheduled `pg_dump`.
3. **Restore has never been tested** → the backups are unproven; RTO is unknown.
4. **Uploaded documents (local storage) are in no backup** (OPS-002).
5. **No encryption at rest** and **no off-site/immutable copy** (ransomware / accidental deletion exposure).

## What does NOT count as a backup (per the audit mandate)
git · Prisma migrations · a local copy of the DB · a backup whose restore was never verified. By
this standard CLUB-OPS currently has **deploy-time local dumps only** — necessary but **not a
durable, proven backup strategy**.

## Target policy (recommendation — NOT implemented here)
- **Scheduled** `pg_dump -Fc` (e.g. hourly/daily) independent of deploys → fixed RPO.
- **Off-site + immutable** copy (object storage with versioning/retention; encrypted).
- **Uploaded files:** use S3 in production (durable) and include the bucket in the backup story; if local is ever used, back it up.
- **Monthly restore rehearsal** into a disposable environment with row-count + financial reconciliation verification (see `backup-restore-rehearsal.md`), recording RPO/RTO.
- **Backup-failure alert** (OPS-007).
