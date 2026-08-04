# CLUB-OPS — Disaster Recovery Plan

Read-only assessment at `dc14d10`. **Current DR posture is WEAK** — the only recovery asset is a
deploy-time, local-only, **unproven** `pg_dump`. RPO/RTO are unknown until a restore is rehearsed
(OPS-001). This plan states the target procedure and the current gaps honestly.

## Production access matrix (§18) — template (fill per org; do not record credentials)
| Capability | Who (role) | MFA | Least-privilege | Shared account? | Offboarding step |
|---|---|---|---|---|---|
| SSH to VM | | required | | none | remove key |
| Postgres (DB) access | | required | read vs write split | none | rotate pw |
| Production env / `.env` | | required | | none | rotate secrets |
| Trigger deploy (CI merge / timer) | | required | | none | remove repo access |
| Run migrations | | required | | none | — |
| Restore backups | | required | | none | — |
| Read backups (contain PII) | | required | | none | — |
**Gap (OPS-017):** this matrix is not documented anywhere in-repo; no rotation/offboarding procedure exists.

## Scenarios
| Scenario | Backup source | Restore order | RPO (current) | RTO (current) | Manual reconciliation | Comms |
|---|---|---|---|---|---|---|
| **Total DB loss** | newest `/opt/club-ops/backups/*.dump` — **BUT co-located with the DB; if the VM/disk is lost the backups are lost too (OPS-001)** | fresh Postgres → `pg_restore` → point app | **= time since last deploy (unbounded)** | **unknown** | `audit:financial-reconciliation` on restored DB | notify tenants of the data-loss window |
| **File storage loss** | S3 bucket (if used) — **if `local`, no backup, unrecoverable (OPS-002)** | restore bucket / remount volume | files since backup lost | unknown | list broken document links | notify affected companies |
| **Region / server loss** | off-site backup — **none today** | rebuild VM → restore DB + files | **all data since last local backup (potentially total)** | unknown | full reconciliation | major-incident comms |
| **Credential compromise** | n/a | rotate all secrets → redeploy → force re-login | n/a | hours | audit access logs | notify per policy |
| **Accidental Company deletion (DATA-008)** | full DB backup | **cannot restore one company alone (OPS-016)** → restore whole DB to a disposable instance, export that company, re-import | since backup | high | reconcile the re-imported company | notify that company |
| **Bad migration** | pre-deploy backup (predates the migrate) | `rollback-runbook.md` step "bad DATA migration" | since backup | unknown | reconciliation on restored DB | maintenance window |
| **Corrupt financial data** | pre-incident backup | restore to disposable; diff via reconciliation; targeted correction | since backup | high | full `audit:financial-reconciliation` | finance sign-off |

## The critical gaps (feed OPS-001/002/016)
1. **No off-site / immutable backup** → a VM/region loss is potentially **total data loss**.
2. **Backups only on deploy** → RPO is unbounded in quiet periods.
3. **Restore never proven** → RTO unknown; DR is theoretical.
4. **No tenant-scoped restore/export** → recovering one company requires a full-DB restore (OPS-016); and `Company` hard-delete (DATA-008) is unrecoverable except by full restore.
5. **Files not in any backup** when storage is `local` (OPS-002).

## Minimum DR to reach before launch (recommendation — NOT implemented)
Scheduled off-site encrypted backups (fixed RPO) → a **rehearsed** restore with recorded RPO/RTO →
company-scoped export/restore tooling → `Company` soft-delete (DATA-008) so an accidental deletion is
reversible without a full restore.

## Update (REM-03)
DB recovery tooling now exists (`backup:database`/`restore:database`, off-site, checksummed, manifested,
guarded — `database-{backup,restore}-runbook.md`). **Total DB loss** recovery is now tooled but the real
PostgreSQL restore is **not yet proven** (OPS-001 PARTIALLY CLOSED; `rem-03-postgres-restore-rehearsal.md`).
**Accidental Company deletion** → `company-deletion-recovery-runbook.md` (DATA-008 still NOT fixed).
**File-storage loss** remains OPS-002/REM-04 — the DB dump excludes uploaded blobs, so full-system recovery
is incomplete until REM-04.

## Update (REM-04)
File durability tooling now exists: production **fails fast** on `local` storage (ARCH-017 CLOSED),
uploads go through an S3 service with SSE + immutable tenant-scoped keys, and there is a read-only
inventory (`audit:file-inventory`), an off-site signed **file manifest** (`backup:files-manifest`),
a safe idempotent **local→S3 migration** (`migrate:files-to-s3`), and blob-recovery runbooks
(`file-storage-runbook.md` / `file-recovery-runbook.md` / `file-storage-alerts.md`). **File-storage
loss** recovery is now tooled (versioning + manifest + recovery runbook) but the real S3
upload/download/restore is **not yet proven** (OPS-002 PARTIALLY CLOSED) and the combined **DB +
blobs** full-system rehearsal + measured RTO is the remaining gate (OPS-001 PARTIALLY CLOSED) —
`docs/testing/rem-04-file-restore-rehearsal.md`, live gates **G-FILE-1..14**. Production MUST set
`STORAGE_PROVIDER=s3` + `STORAGE_S3_*` (private bucket, SSE, versioning + lifecycle, least-privilege
creds separate from `BACKUP_S3_*`).
