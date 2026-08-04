# REM-03 — Target Backup Architecture

```
PostgreSQL → pg_dump -Fc → secure temp staging → SHA-256 → manifest.json
          → (TLS) upload dump + .sha256 + .manifest.json → S3-compatible off-site bucket
          → remote HEAD/size verify → temp cleanup → structured result
```

## Object key structure
`<environment>/<YYYY>/<MM>/<DD>/<UTCtimestamp>-<deploymentVersion>-db.dump` (+ `.sha256`, `.manifest.json`).
UTC timestamp, collision-safe (no overwrite; immutable object semantics via bucket versioning/object-lock).
**No company names, no DB secret identifiers, no secrets** in keys.

## Backup types (one shared core)
- **scheduled** — daily (independent of deploy), the primary RPO driver.
- **pre-deploy** — before migrate; deploy aborts on failure (kept + moved off-site).
- **manual** — before a repair/backfill, by an authorized operator.
- **pre-financial-migration** — before a money data repair.

## S3 env contract (provider-neutral)
`BACKUP_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY/FORCE_PATH_STYLE/PREFIX`,
`BACKUP_RETENTION_DAYS`, `BACKUP_SCHEDULE`, `BACKUP_ENCRYPTION_MODE`, `BACKUP_ENVIRONMENT`,
`BACKUP_ALERT_TARGET?`. **Production fail-fast** when scheduled backup is enabled but config is incomplete.
Credentials are separate from the app file-storage keys where possible; least privilege
(PutObject/GetObject/ListBucket-by-prefix, DeleteObject only if a retention worker needs it); never logged.

## Encryption (first run)
Private bucket + TLS transport + **server-side encryption** (SSE-S3, or SSE-KMS if a key exists) +
versioning/object-lock if the provider supports it. Client-side encryption is deferred (no safe key
management yet). The report records the mode actually proven.

## Retention
Prefer **bucket lifecycle** over custom delete logic: daily 14–30d, weekly a few weeks, monthly a few
months; pre-deploy its own policy. A retention worker (if any) runs dry-run first, only within the
configured prefix, never deletes the last successful backup or an incident backup, and logs deletions.

## Consistency (pg_dump flags)
`-Fc` (custom, single consistent snapshot), `--no-owner --no-acl` (portable restore into a fresh
disposable DB without production superuser). Extensions/roles are documented separately (not required for
the rehearsal). Large objects: included by `-Fc` by default (the app stores blobs on disk/S3, not in the
DB — REM-04).
