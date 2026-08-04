# REM-03 — Restore Design

`restore:database` restores into a **disposable** PostgreSQL only. Hard guards (`isSafeRestoreTarget`):
refuses a production target; requires `--confirm-disposable`; refuses a sqlite target; a production-looking
key needs `RESTORE_ALLOW_PROD_KEY=true` (isolated forensic host only). It never DROPs production and never
runs `migrate reset`.

## Flow
1. Validate target (guards above). 2. Download `db.dump` + `.manifest.json` + `.sha256`. 3. **Verify SHA-256
before restoring** (a corrupt/incomplete dump aborts at `CHECKSUM_MISMATCH`). 4. `pg_restore --no-owner
--no-acl --clean --if-exists` into the empty disposable DB. 5. Recompute `computeBackupChecksums` on the
restored DB. 6. **Compare to the manifest** (row counts + money aggregates) then report `checksumMatch`.

## Restore validation matrix (post-restore)
Row counts + tenant links + money totals + status distribution + latest timestamps + orphan counts for:
Company, Club, LegalEntity, User, CompanyUserAccess, Invoice, InvoicePayment, Expense, Refund,
BalanceSnapshot, cash ops, OFD summaries/raw, PayrollPeriod/Calculation/Payment/PaymentObligation, Budget,
file metadata, audit history. Then run `audit:data-integrity`, `audit:financial-reconciliation`,
`preflight:payroll-payments`, `preflight:cash-cutover`, `prisma validate`, `build:prod`, smoke login.

## File-blob limitation (before REM-04)
The DB dump restores file **metadata** only. Uploaded document **blobs** live on disk/S3 (not in the DB), so
they are **NOT** in this backup. The restore report states this explicitly; **full-system recovery is
incomplete until REM-04** (back up + restore the uploads).
