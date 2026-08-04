# REM-03 — Current Backup Risk (OPS-001)

Proof of the current model's limitations (from `deploy/deploy.sh`).

## Facts
1. **Deploy-only trigger.** `pg_dump -Fc` runs only inside `deploy.sh` before a migrate (`:200`). No
   scheduled backup ⇒ in a quiet period (no deploys) there is **no fresh backup**; RPO grows unbounded.
2. **Same failure domain.** `BACKUP_DIR=/opt/club-ops/backups` (`:24`) is on the **same VM disk** as the
   `club_ops_postgres_data` volume. A VM loss, disk failure, or region loss destroys the DB **and** all 7
   backups simultaneously → **total data loss**.
3. **No off-site copy.** No S3/rclone/restic/scp — the audit scan (`storage-risk.json`) found none.
4. **No encryption at rest.** Dumps are `chmod 600` (root-only) but not encrypted; a disk-image leak
   exposes all financial data.
5. **Restore never tested.** No evidence of an executed `pg_restore`. The dumps are **unproven** ⇒ RTO is
   unknown and recovery is theoretical. "A backup file is not a backup until a restore is proven."
6. **Uploaded document blobs are in no backup** (OPS-002; REM-04) — even a perfect DB restore is a partial
   system recovery.

## Consequences
- **RPO:** time since the last deploy — **not a fixed, guaranteed RPO.**
- **RTO:** **unknown** (never measured).
- **DR:** a VM/region loss is potentially **total, unrecoverable** data loss.
- **Money incidents:** a bad data migration's recovery path (restore) is **unverified** — the exact
  situation REM-01/REM-02 remediations assume is recoverable.

## What REM-03 changes
Adds scheduled + pre-deploy **off-site**, checksummed, manifested, encrypted (bucket-side) backups; a
guarded restore tool; a proven restore rehearsal (on real PostgreSQL — the gate); measured RPO/RTO; and a
deploy gate that aborts on backup failure. It does **not** fix DATA-008 (Company delete) or OPS-016
(tenant restore) — those get runbooks + a documented PARTIALLY CLOSED status.
