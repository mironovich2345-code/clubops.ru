# REM-03 — Off-site Backup & Proven Restore — Final Report

## 1. Baseline
`5f2a866` (tsc clean · pilot:full 3913/0 · prisma dev+prod valid · build:prod compiles). Additive only; no
production mutation, no destructive restore, no schema reset, no backup deletion, no financial-data/RBAC/
business-logic change.

## 2–3. Backup architecture (before → after)
**Before:** `pg_dump -Fc` **only on deploy**, LOCAL to the VM disk (same failure domain as the DB), 7 kept,
no off-site, no encryption, restore never tested → RPO = time-since-deploy, RTO unknown (OPS-001).
**After:** a provider-neutral off-site backup: `pg_dump -Fc --no-owner --no-acl` → SHA-256 → manifest (with
critical row counts + money checksums) → TLS upload of dump + `.sha256` + `.manifest.json` to a private
S3-compatible bucket (server-side encryption) → remote HEAD/size verify → temp cleanup → structured result.
Single core (`scripts/backup-database.mjs`) for scheduled / pre-deploy / manual / pre-financial-migration.

## 4. Schedule / 5. Pre-deploy / 6. Off-site interface / 7. Bucket security
- **Scheduled:** systemd `club-ops-backup.timer` daily 02:30 UTC (independent of deploy). Railway: use its cron with the same command.
- **Pre-deploy:** `deploy.sh` adds a verified off-site pre-deploy backup that **aborts the deploy on failure** (local dump kept as a fast secondary).
- **Off-site:** provider-neutral `BACKUP_S3_*` env via `@aws-sdk/client-s3` (PutObject/HeadObject/ListObjects/GetObject). **Production fail-fast** when off-site is required but config is incomplete.
- **Bucket:** private, versioning + lifecycle + restricted delete, separate credentials, never logged, keys carry no secrets/company names.

## 8–12. Dump flags / checksum / manifest / encryption / locking
`-Fc --no-owner --no-acl` (portable restore into a fresh disposable DB, no prod superuser). SHA-256 streamed.
Manifest per `rem-03-backup-manifest-spec.md` (secret-refusing builder). Encryption: SSE-S3 (SSE-KMS optional;
client-side deferred). Single-flight lockfile (stale after 2h) + systemd non-overlap.

## 13–15. Retention / monitoring / restore safeguards
Retention via bucket lifecycle (daily 14–30d, weekly, monthly; pre-deploy own policy) — never deletes the last
good backup. Alerts in `database-backup-alerts.md` (no-backup-in-RPO = S0). Restore refuses production, requires
`--confirm-disposable`, verifies the checksum before restoring, compares restored checksums to the manifest.

## 16–20. Rehearsal / row counts / money aggregates / integrity — RESULT
**NOT EXECUTED** in this sandbox (no `pg_dump`/`pg_restore`/Docker/S3). Shipped as tooling + the precise gate
`docs/testing/rem-03-postgres-restore-rehearsal.md` (real PostgreSQL + test S3). The **executable** logic IS
proven: `test:rem-03-backup-restore` **23/23** (env/sqlite rejection, manifest no-secrets, key structure,
redaction, restore guards, corrupt-dump reject, checksum compare, dry-run no-upload, fail-fast).

## 21–22. RPO / RTO
**Target RPO:** ≤ 24h (daily scheduled) + a pre-deploy + a pre-repair backup. **Actual RPO/RTO:** to be
**measured** by the PostgreSQL rehearsal (RTO = download→checksum→restore→reconcile wall-clock). Until then,
neither is proven — a scheduled config is not a proven RPO.

## 23. File-blob limitation
The DB dump restores file **metadata** only; uploaded document **blobs** are not in the dump (REM-04). Full-
system recovery is **incomplete until REM-04**; the restore report says so explicitly.

## 24. Findings closure
| Finding | Status | Why |
|---|---|---|
| **OPS-001** co-located, unproven backup | **PARTIALLY CLOSED** | off-site tooling + scheduler + deploy gate + manifest/checksum shipped and tested; **CLOSED only after the real PostgreSQL restore rehearsal** (`G-BACKUP-3/4`) proves a restore off-site — NOT EXECUTED here. |
| **OPS-013** DATABASE_URL validation (backup half) | **CLOSED** | `validateDatabaseUrl` rejects sqlite/non-postgres/empty; the backup CLI refuses to run otherwise. |
| **OPS-016** tenant-scoped restore/export | **PARTIALLY CLOSED** | whole-DB restore into an isolated env + a company-export runbook; automatic single-tenant restore is a future REM. |
| **DATA-008** Company hard-delete | **NOT CLOSED** | recovery runbook only; the soft-delete + guard fix is a separate remediation. |

## 25–26. Pilots / build
`pilot:rem-03-backup-restore` (structural) in pilot:full; **pilot:full green**; tsc clean; build:prod compiles.

## 27. Commits
See `git log` — baseline/risk/architecture+tooling+23-tests · systemd+deploy-integration · docs+pilot.

## 28. Open live gates
G-BACKUP-1..10 (`rem-03-backup-restore-checklist.md`) — esp. G-BACKUP-3 (restore into empty PostgreSQL),
G-BACKUP-4 (row counts + money aggregates match), G-BACKUP-7 (measured RPO/RTO), G-BACKUP-8 (pre-deploy
failure blocks deploy).

## 29. Required production configuration
Set `BACKUP_S3_*` (private bucket, SSE, versioning/lifecycle, separate least-privilege creds) + enable
`club-ops-backup.timer`; run the PostgreSQL rehearsal on a test bucket; record RPO/RTO; then flip OPS-001 to CLOSED.

## 30. Next remediation
REM-04 (enforce S3 for uploads + back up + restore document blobs, OPS-002) — required for full-system recovery.

## Definition of Done
Independent-of-deploy backup ✅ · off-site ✅ · checksum + manifest ✅ · remote verify ✅ · **real PostgreSQL
restore proven ⛔ NOT EXECUTED (gate)** · restored money aggregates match — proven by checksum-compare logic,
to be run on pg ⛔ · RPO/RTO measured ⛔ (gate) · failed backup blocks deploy ✅ · production restore guarded ✅
· production data unchanged ✅ · full-system recovery honestly incomplete until REM-04 ✅ · build + pilot:full
green ✅. **OPS-001 stays PARTIALLY CLOSED until the PostgreSQL rehearsal passes.**
