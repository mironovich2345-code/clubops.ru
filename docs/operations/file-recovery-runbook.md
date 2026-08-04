# File Recovery Runbook (REM-04)

How to recover document blobs. Pairs with `database-restore-runbook.md` (REM-03) for a full
system restore. **No destructive action against production blobs is automatic.**

## 1. A single missing / corrupted object
1. Confirm with `audit:file-inventory` (FI-01 missing / FI-04 hash mismatch) — note the fileId,
   company, entity (keys are shown hashed).
2. Recover the object from bucket **versioning** (previous version) or the replica/backup copy.
3. Verify the recovered object's sha256 against the manifest / metadata.
4. Restore under the original key, or store a repaired version and update `storageKey`
   explicitly (audit the change). Never overwrite a different-hash object silently.

## 2. Whole-system restore (DB + blobs)
1. Restore PostgreSQL to a disposable instance (`restore:database --confirm-disposable`).
2. Point the app at the restored/test S3 config (read-only creds if only verifying).
3. `audit:file-inventory` → every live row's blob present + hash-match.
4. Open representative documents (invoice/expense/refund/payroll); verify hashes.
5. `audit:financial-reconciliation`. Measure and record full-system RTO.

## 3. Tenant export / recovery (OPS-016)
1. Restore the DB to an isolated environment.
2. List company-scoped files by the tenant key prefix (`<env>/<companyId>/…`).
3. Copy only that prefix to the target; validate every hash.
4. Do not bulk-merge into a live production tenant automatically.

## 4. Accidental blob deletion
- Bucket versioning makes an accidental delete recoverable (restore the delete marker's prior
  version). If versioning was off (misconfig), recover from the last manifest's referenced copy;
  if neither exists, the object is lost since the last backup — record the data-loss window.

## Guardrails
- Restore into a **disposable** target first; never overwrite production blobs during a drill.
- Keep the local source blob until final acceptance during a migration.
- Every recovery is audited (who, when, which fileId, sha256 before/after).
