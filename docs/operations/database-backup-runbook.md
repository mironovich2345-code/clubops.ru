# Runbook — Database Backup (REM-03)

## Scheduled (automatic)
systemd `club-ops-backup.timer` (daily 02:30 UTC) runs `club-ops-backup.service` →
`node scripts/backup-database.mjs --type=scheduled`. Independent of deploy. Single-flight lock + systemd
non-overlap. Failures surface in journald (alert on non-zero — see `database-backup-alerts.md`).

## Pre-deploy (automatic)
`deploy/deploy.sh` creates a LOCAL `pg_dump`, then (if `BACKUP_S3_BUCKET` is set) a verified OFF-SITE
pre-deploy backup; a failed off-site backup **aborts the deploy**.

## Manual (before a repair/backfill)
`node scripts/backup-database.mjs --type=manual` (or `--type=pre-financial-migration` before a money repair).

## Config (production MUST set)
`BACKUP_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY` (+ optional FORCE_PATH_STYLE / PREFIX),
`BACKUP_RETENTION_DAYS` (default 14), `BACKUP_ENCRYPTION_MODE` (sse-s3), `BACKUP_ENVIRONMENT`. Private bucket,
versioning + lifecycle + restricted delete, credentials separate from the app file-storage keys, never logged.

## Verify
`node scripts/backup-list.mjs` — the newest object appears with its manifest + restore-tested status.
