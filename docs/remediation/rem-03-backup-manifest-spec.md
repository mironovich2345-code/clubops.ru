# REM-03 — Backup Manifest Spec

Every backup uploads three objects: `<key>-db.dump`, `<key>-db.dump.sha256`, `<key>-db.dump.manifest.json`.
The manifest (built by `scripts/lib/backup-core.mjs::buildManifest`, `formatVersion="rem-03.v1"`) contains:

| Field | Meaning |
|---|---|
| formatVersion / backupId / backupType | rem-03.v1 · unique id · scheduled/pre-deploy/manual/pre-financial-migration |
| environment / createdAt / completedAt | env label · UTC start/end |
| deploymentVersion / gitCommit | APP_GIT_SHA / APP_DEPLOYMENT_ID |
| databaseProvider / postgresServerVersion / pgDumpVersion | postgresql · server + tool versions |
| schemaMigrationCount / latestMigration | migration state at backup |
| dumpSizeBytes / sha256 | integrity |
| **criticalRowCounts** | counts for 21 critical tables (Company … AuditLog) |
| **criticalMoneyChecksums** | sums for invoice / invoicePayment(confirmed) / expense(confirmed) / refund(paid) / payrollCalculation(netPayable, paid) / payrollPayment(confirmed) / balanceSnapshot(active) / budget |
| encryption / storageProvider / objectKey | sse-s3/sse-kms/none · s3-compatible · key |
| restoreTestedAt / restoreTestResult | set when a restore rehearsal validates this backup (nullable) |

**Never in the manifest:** DATABASE_URL, passwords, access keys, private keys, per-person records. The
builder throws if any secret-looking value would be embedded. The money checksums are an **identity check**
(backup == restore), NOT an accounting source of truth.
