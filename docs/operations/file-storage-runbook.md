# File Storage Runbook (REM-04)

Operating the S3-compatible object storage that holds all uploaded documents.

## Production config (required)
```
STORAGE_PROVIDER=s3
STORAGE_S3_ENDPOINT=https://<region>.<provider>       # RU object storage or AWS
STORAGE_S3_REGION=ru-central1
STORAGE_S3_BUCKET=<private-bucket>                     # NO public ACL
STORAGE_S3_ACCESS_KEY_ID=<least-privilege key>
STORAGE_S3_SECRET_ACCESS_KEY=<secret>                 # server-only, never logged
STORAGE_S3_FORCE_PATH_STYLE=true                      # most compatible across RU providers
STORAGE_S3_PREFIX=clubops                             # optional namespace
STORAGE_S3_SERVER_SIDE_ENCRYPTION=AES256              # or aws:kms + STORAGE_S3_KMS_KEY_ID
STORAGE_SIGNED_URL_TTL_SECONDS=300                    # <= 3600
STORAGE_MAX_FILE_SIZE_BYTES=15728640
STORAGE_ENVIRONMENT=production
```
The app **fails fast at startup** if the provider is not `s3` or the config is incomplete
(`assertStorageConfigured`). The health endpoint exposes the provider NAME only.

## Bucket policy (review = G-FILE-14)
- Private; block all public access; no public ACL.
- **Versioning ON** (recover an overwritten/deleted object).
- Lifecycle for temp/ only; **never expire the last version of a financial document**.
- Server-side encryption (SSE-S3 or SSE-KMS).
- Least-privilege credentials, **separate** from the backup bucket (`BACKUP_S3_*`).

## Routine operations
- **Inventory** (read-only): `npm run audit:file-inventory` — reconcile metadata ↔ blobs.
- **Preflight** (read-only): `npm run preflight:file-storage` — go/no-go before a cutover.
- **Manifest** (off-site catalog): `npm run backup:files-manifest --type=scheduled` (schedule
  daily alongside the DB backup).
- **Migration** (local→S3): see `docs/remediation/rem-04-local-to-s3-migration.md`.

## Readiness
`storageReadiness()` (config) + `probeStorage()` (bounded HEAD/list under a health prefix) feed
the REM-06 `/api/health/ready` endpoint. DB + storage are required for traffic; AI/OFD/SMTP can
be degraded separately. A transient probe failure is "degraded", not a process crash.

## Do NOT
- Do not set `STORAGE_PROVIDER=local` in production.
- Do not hard-delete financial-document blobs via ordinary operations (archive/supersede).
- Do not log or echo credentials, bucket, or endpoint alongside PII.
