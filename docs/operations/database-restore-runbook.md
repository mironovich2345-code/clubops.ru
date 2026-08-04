# Runbook — Database Restore (REM-03) — DISPOSABLE ONLY

**Never restore over production.** Restore into an isolated disposable PostgreSQL, verify, then decide.

1. Pick a backup: `node scripts/backup-list.mjs`.
2. Provision an empty disposable PostgreSQL (never production).
3. `node scripts/restore-database.mjs --key=<objectKey> --target-url=<disposable-pg> --confirm-disposable`
   — verifies the checksum BEFORE `pg_restore`, then compares restored row counts + money aggregates to the
   manifest. A mismatch or corrupt dump aborts.
4. On the restored DB run: `audit:data-integrity`, `audit:financial-reconciliation`, `preflight:payroll-payments`,
   `preflight:cash-cutover`, `prisma validate`, `build:prod`, smoke login.
5. Record duration (RTO) and PASS/FAIL; if this validated the backup, stamp `restoreTestedAt/Result` in its manifest.
6. **File blobs are NOT restored** (REM-04) — note the gap.

**Production recovery** (bad migration / DR) is a SEPARATE human-run procedure: restore into a disposable DB
first (this runbook), verify, coordinate a maintenance window, then `pg_restore` into a fresh prod DB only
after sign-off. Never blind-restore onto the live volume.
