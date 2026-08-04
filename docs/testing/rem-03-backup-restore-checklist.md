# REM-03 — Backup/Restore Live Acceptance Checklist

Run on a host with real PostgreSQL + an S3-compatible **test** bucket. Automated logic proof is done
(`test:rem-03-backup-restore` 23/23). These are the live gates that close OPS-001.

- [ ] **G-BACKUP-1** Scheduled backup uploaded off-site (`club-ops-backup.timer` → object in the bucket).
- [ ] **G-BACKUP-2** Remote checksum verified (`.sha256` matches the uploaded dump; HEAD size matches).
- [ ] **G-BACKUP-3** Restore into an EMPTY disposable PostgreSQL completes (`restore:database --confirm-disposable`).
- [ ] **G-BACKUP-4** Restored **row counts and money aggregates MATCH** the manifest (checksum compare = match).
- [ ] **G-BACKUP-5** `audit:data-integrity` on the restored DB passes (or anomalies explained).
- [ ] **G-BACKUP-6** `audit:financial-reconciliation` on the restored DB passes (or anomalies explained).
- [ ] **G-BACKUP-7** Measured RPO (time since last verified backup) + RTO (restore wall-clock) recorded.
- [ ] **G-BACKUP-8** A failed pre-deploy backup demonstrably BLOCKS the deploy (bad creds → deploy aborts).
- [ ] **G-BACKUP-9** Backup credentials + bucket policy reviewed (private, SSE, versioning, least-privilege, separate from app storage).
- [ ] **G-BACKUP-10** A restore operator follows `database-restore-runbook.md` end-to-end without developer improvisation.
- [ ] Corrupt-dump negative test: a flipped byte → restore aborts at CHECKSUM_MISMATCH.
- [ ] File-blob gap acknowledged (blobs not in the DB dump — REM-04).

**Sign-off:** OPS-001 → CLOSED only when G-BACKUP-1..8 pass on real PostgreSQL and RPO/RTO are recorded.
Until then OPS-001 is PARTIALLY CLOSED.
