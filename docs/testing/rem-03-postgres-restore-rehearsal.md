# REM-03 — PostgreSQL Backup/Restore Rehearsal (status: NOT EXECUTED)

**Status: NOT EXECUTED.** This sandbox has no `pg_dump`, no `pg_restore`, no Docker, and no S3/MinIO. The
real PostgreSQL backup + off-site upload + restore therefore **cannot** run here. This is the precise gate
to execute on a real PostgreSQL + an S3-compatible test bucket (MinIO/LocalStack/provider test bucket)
before **OPS-001 can be marked CLOSED**. Until then OPS-001 is **PARTIALLY CLOSED** (tooling + deploy gate
ready; restore unproven).

## Preconditions
- A disposable PostgreSQL (matching the prod major version) — never production.
- An S3-compatible **test** bucket (never the production backup bucket); `BACKUP_S3_*` env set.
- The repo at the release commit.

## Steps (the gate)
1. Seed the disposable PostgreSQL with a representative or sanitized dataset; record `computeBackupChecksums`.
2. **Backup:** `node scripts/backup-database.mjs --type=manual` → uploads `db.dump`, `.sha256`, `.manifest.json`
   to the test bucket; remote HEAD/size verify passes. Record duration.
3. `node scripts/backup-list.mjs` → the object appears with its manifest.
4. **Restore:** into a fresh empty disposable DB:
   `node scripts/restore-database.mjs --key=<objectKey> --target-url=<disposable-pg> --confirm-disposable`
   → checksum verified BEFORE `pg_restore`; restore succeeds; recomputed checksums **match the manifest**.
   Record duration (= RTO component).
5. Run on the restored DB: `audit:data-integrity`, `audit:financial-reconciliation`, `preflight:payroll-payments`,
   `preflight:cash-cutover`, `prisma validate`, `build:prod`, smoke login.
6. Verify the restore-validation matrix (row counts, tenant links, money totals, status distribution, orphan
   counts) — see `rem-03-restore-design.md`.
7. **Corrupt-dump negative test:** flip a byte in the uploaded dump → restore aborts at CHECKSUM_MISMATCH.
8. **Pre-deploy abort test:** make `backup-database.mjs --type=pre-deploy` fail (bad creds) → deploy stops.

## Pass criteria (G-BACKUP-3/4/5/6/7/8)
- Backup uploaded off-site + remote checksum verified.
- Restore into an empty PostgreSQL completes; **row counts + money aggregates MATCH** the manifest.
- `audit:data-integrity` + `audit:financial-reconciliation` pass (or anomalies explained).
- Measured RPO (time since last verified backup) + RTO (steps 2→5 wall-clock) recorded.
- A failed pre-deploy backup demonstrably blocks the deploy.

## What this proves / does not
Proves a durable off-site backup restores to an identical DB on real PostgreSQL. Does **not** restore
uploaded document **blobs** (REM-04) — full-system recovery stays incomplete until then.
