# REM-04 — File Backup & Restore Design

Object-storage durability is necessary but **not** a recovery plan. REM-04 adds a signed
manifest + three restore scenarios so file recovery is proven, not assumed.

## Manifest / catalog (`npm run backup:files-manifest`)
- Builds a signed inventory manifest: `fileId, companyId, entityType/entityId, storageKey,
  sha256, sizeBytes, status, uploadedAt, verifiedAt` + a blob-present cross-check.
- No PII / original filenames. sha256-checksummed. Refuses any secret-looking value.
- Stored off-site in the **backup** bucket (`BACKUP_S3_*` — separate creds from the app storage
  bucket `STORAGE_S3_*`). Modes: scheduled / pre-deploy / manual, `--dry-run`, `--local-only`.
- Does **not** download every blob; it records durability assumptions (versioning, lifecycle,
  replication).

## Restore scenarios
### A. Whole-system restore
1. Restore PostgreSQL (REM-03 `restore:database`) → file metadata recovered.
2. Point the app at the restored/test S3 config.
3. Run `audit:file-inventory` → every live metadata row's blob must be present + hash-match.
4. Missing blobs are reported (recover from version/replica/backup).

### B. Object recovery
- Recover a deleted/corrupted object from bucket **versioning** / replica / manifest reference.
- Verify sha256 against the manifest; restore the original key or a repaired version; audit.

### C. Tenant export / recovery
- Restore the DB to an isolated environment, list the company-scoped files (tenant key prefix),
  copy only the authorized prefix, validate hashes. Never bulk-merge into production
  automatically (feeds OPS-016).

## Integrity
Every restore compares **row counts + money aggregates** (REM-03 checksums) AND **file hashes**
(this manifest). A blob whose sha256 doesn't match the manifest is a recovery failure, surfaced
by the inventory (`FI-04`, S0).

## Limitation before this is "DR proven"
The **real S3 upload/download/restore rehearsal** and the **combined DB + blobs full-system
rehearsal** are the gates (`docs/testing/rem-04-file-restore-rehearsal.md`). Until they pass on a
real bucket, OPS-002 stays PARTIALLY CLOSED and OPS-001 remains PARTIALLY CLOSED.
