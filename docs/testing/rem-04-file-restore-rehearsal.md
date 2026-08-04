# REM-04 — File Restore Rehearsal (LIVE GATE)

Run on a host with a **disposable S3-compatible** environment (MinIO / LocalStack / a test
bucket). Automated logic proof is done (`test:rem-04-file-storage` 31/31 — real TS service
round-trips against the local provider). These are the LIVE gates that close OPS-002.

> **Status in the CI sandbox: NOT EXECUTED.** There is no MinIO/LocalStack/S3 here, so the real
> upload/download/restore cannot run. Mocks do not prove durability. Ship tooling + tests; run
> this on staging.

## A. Object storage rehearsal
1. Configure `STORAGE_PROVIDER=s3` + `STORAGE_S3_*` against the disposable bucket.
2. Upload representative files (invoice PDF, expense proof, refund docs, payroll proof).
3. Record DB metadata + sha256 for each.
4. `backup:files-manifest --type=manual` → manifest + checksum off-site.
5. Simulate an application redeploy/restart (new process, no local volume).
6. Download each file from a SECOND process/instance → bytes + hash match.
7. Simulate object deletion / corruption (delete a key; flip a byte via a new version).
8. Recover from version/backup/test copy → verify sha256.
9. Restore the DB metadata snapshot (REM-03).
10. `audit:file-inventory` → metadata ↔ blobs reconcile (0 S0/S1).

## B. Full-system rehearsal (combine with the REM-03 gate)
1. Restore PostgreSQL into empty disposable PostgreSQL (REM-03 G-BACKUP-3/4).
2. Start the app against the restored DB.
3. Connect the restored/test S3 config.
4. Run `audit:file-inventory`.
5. Open: invoice PDF · expense proof · refund documents · payroll proof.
6. Verify hashes against the manifest.
7. Run `audit:financial-reconciliation`.
8. Measure full-system **RTO** (DB + blobs) and record it.

Until B passes, **DR is not proven** — a scheduled backup + a durable bucket is not a measured
recovery.

## Sign-off
OPS-002 → CLOSED only when A passes on a real bucket with multi-instance download proven and
inventory reconciled. OPS-001 → CLOSED only when B (DB + blobs) passes with RTO recorded.
