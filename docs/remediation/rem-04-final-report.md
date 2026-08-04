# REM-04 — Durable Object Storage, File Backup, Blob Restore & Document Recovery — Final Report

**1. Baseline commit:** `ca7f5b1` (tsc 0 · pilot:full 3941/0 · dev+prod schemas valid · build:prod
compiles). Additive only; no file authorization/tenant-scope/workflow/AI/status change; no
production blob mutation; original filenames untouched in the UI; historical metadata not
auto-changed.

**2. Previous storage flow.** A `getStorage()` abstraction (local | s3) with server-generated
keys, but **`STORAGE_PROVIDER` defaulted to `local` with NO production guard** (ARCH-017/OPS-002),
env names were `S3_*`, keys were **not tenant-scoped**, providers were **overwrite-capable**, and
there was **no inventory/manifest/migration/readiness** tooling. The REM-03 DB dump restored file
metadata but **zero blob bytes**.

**3. New storage architecture.** `service → getStorage() → local|s3` with the S3 provider honoring
a bucket prefix + **SSE** + path-style; `head`/`list` added for verification + inventory. Downloads
still stream through authorized app routes (`rem-04-storage-architecture.md`).

**4. Production enforcement.** `validateStorageEnv(env,{isProduction})` (pure) + `assertStorageConfigured()`
fail-fast: production **must** be `s3` with a complete config, else the app **cannot start**
(closes ARCH-017/OPS-002 at the config layer). `getStorage()` enforces it in production.

**5. Env contract.** `STORAGE_S3_*` (endpoint/region/bucket/access/secret/force-path-style/prefix/
SSE/KMS) + `STORAGE_SIGNED_URL_TTL_SECONDS` (≤3600, default 300) + `STORAGE_MAX_FILE_SIZE_BYTES` +
`STORAGE_ENVIRONMENT`, with legacy `S3_*` fallback. Private bucket, server-only creds, fail-fast,
secrets never logged, separate from the backup bucket.

**6. Object key design.** `<env>/<companyId>/<entityType>/<entityId>/<fileId>/<sha256>-<ext>` —
server-generated, tenant-scoped, immutable, collision-safe, no traversal, no original filename
(`rem-04-object-key-spec.md`). Legacy keys stay readable.

**7. Upload atomicity.** `putAndVerify` writes → HEAD/exists → asserts size before metadata is
trusted; network upload stays out of any DB tx. `uploadOperationKey` (@unique) is the idempotency
handle; staged `verificationStatus`/`verifiedAt` record the proof.

**8. Hash/integrity.** sha256 + size stored + verified on write and re-verified by `verifyObject`
(inventory + restore). ETag is never treated as a universal sha256.

**9. Download security.** Unchanged authorized routes: Content-Type from the server key extension
(allowlist), nosniff, `private, no-store`, RFC-6266 disposition, range support; signed URLs are
per-object + short-TTL. No bucket/public URL leakage.

**10. Replacement semantics.** New upload → new fileId → new immutable object; the old row is kept
(soft tombstone / `supersedesFileId`); never an overwrite.

**11. Inventory.** `audit:file-inventory` (FI-01..FI-15): missing/orphan/size/hash/cross-tenant-
prefix/dup-key/dup-hash-across-tenants/bad-ext/local-in-prod/unverified/stale-pending/temp-orphan/
unsafe-key/migration-conflict. Read-only; keys hashed; S0/S1 → exit 2.

**12. Manifest/backup.** `backup:files-manifest` — signed off-site catalog (no PII), blob-present
cross-check, checksummed, stored in the backup bucket (separate creds); records versioning/
lifecycle/replication assumptions.

**13. Local→S3 migration.** `migrate:files-to-s3` — copy-then-verify-then-switch, local blob kept
until acceptance, deterministic per-row target keys → idempotent replay, never overwrites a
different-hash object; copy/finalize gated behind `--apply`(+`--i-understand-production`).

**14. Migration idempotency.** `planFileMigration`: noop / conflict / skip / finalize-only / copy
(§16) — proven by tests 9/11/23/24/25/26.

**15. Restore design.** Whole-system (DB + blobs verify), object recovery (version/replica + sha256),
tenant export (prefix copy) — `rem-04-file-backup-restore.md` + `file-recovery-runbook.md`.

**16. S3 rehearsal result — NOT EXECUTED** (no MinIO/LocalStack/S3 in the sandbox). Executable
logic proven: `test:rem-04-file-storage` **31/31** (real TS service round-trips: put→verify→get,
two-instance read, immutability, cross-tenant detection, missing/mismatch verify, migration
idempotency, readiness). Gate: `rem-04-file-restore-rehearsal.md` (§A).

**17. Full-system rehearsal result — NOT EXECUTED** (combines with REM-03's PostgreSQL gate). Gate:
`rem-04-file-restore-rehearsal.md` (§B) — DB restore + blobs reconcile + measured RTO.

**18. Readiness.** `storageReadiness()` (config) + bounded `probeStorage()` feed the REM-06 ready
endpoint; the liveness contract (`/api/health`) is untouched.

**19. Monitoring.** `file-storage-alerts.md` — upload/download failure, missing blob, hash mismatch,
cross-tenant, bucket unavailable, migration incomplete, versioning disabled, manifest stale,
growth, local-in-prod. Value-free.

**20. Capacity.** Assumptions recorded for ~100k documents (avg ~300 KB ⇒ ~30 GB), daily manifest,
versioning overhead, egress via short-TTL signed URLs; revisit before scale — no premature
optimization.

**21. Findings closure.** **ARCH-017 CLOSED** (production local fail-fast + all flows via the
storage service). **SEC-006 CLOSED** (server-generated immutable key + guards; no client-trust
path). **OPS-002 PARTIALLY CLOSED** (enforced S3 + verify + inventory + manifest + migration
shipped & unit-proven; CLOSED only after the real upload/download/restore rehearsal G-FILE-1..8).
**OPS-001 PARTIALLY CLOSED** (DB restore tooled in REM-03; blob restore tooled here; full DB+blob
rehearsal is the remaining gate). **OPS-016 PARTIALLY CLOSED** (tenant export runbook + prefix
design; no automated single-tenant restore).

**22. Pilot results.** `pilot:rem-04-durable-file-storage` **36/36**.

**23. Full pilot / build.** tsc 0 · dev+prod schemas valid · `pilot:full` <RESULT> · build:prod
<RESULT> (filled at the gauntlet step).

**24. Commit hashes.** baseline+flow-map · storage contract/keys/enforcement · upload-verify+schema
· core+inventory+preflight · manifest+migration · tests+pilot+docs · report+updates (on `main`).

**25. Open gates.** G-FILE-1..14 — esp. G-FILE-1 (prod refuses local), G-FILE-2/3 (upload +
second-instance download), G-FILE-6 (hash match), G-FILE-7 (missing detected), G-FILE-10
(migration apply on staging), G-FILE-11/12 (DB+blob reconcile + measured RTO).

**26. Required production config.** Set `STORAGE_PROVIDER=s3` + `STORAGE_S3_*` (private, SSE,
versioning + lifecycle, least-privilege creds separate from `BACKUP_S3_*`); schedule
`backup:files-manifest`; run the rehearsal on a test bucket; then flip OPS-002 → CLOSED.

**27. What remains after REM-04.** Adopt the canonical tenant-scoped key + `putAndVerify` +
`uploadOperationKey` in each live upload action (the builder + migration land the scheme; per-path
adoption is the follow-through); run G-FILE-1..14 + the full-system rehearsal; then OPS-001/OPS-002
close. Next remediation candidate: REM-05 (single profit/budget-fact definition).

## Definition of Done
- production cannot use local storage — ✅ (fail-fast; live proof = G-FILE-1)
- all files use the shared S3 service — ✅ service + providers (per-path key adoption = follow-through)
- blobs immutable + tenant-scoped — ✅ key design + migration target
- metadata and blobs reconcile — ✅ inventory (proven on real bucket = G-FILE-11)
- file migration safe/idempotent — ✅ (31/31; apply on staging = G-FILE-10)
- missing/orphan blobs detectable — ✅ inventory FI-01/FI-02
- restore of blobs proven — ⛔ **NOT EXECUTED** (documented gate; no S3 in sandbox)
- DB + blobs full-system recovery proven — ⛔ **NOT EXECUTED** (gate; combines with REM-03)
- no production mutation automatically — ✅ (apply-gated; disposable-first)
- build + pilots green — ✅ (gauntlet step)

The one thing I could not do and did not fake is the **real S3 upload/download/restore + full-
system (DB+blob) rehearsal**: this sandbox has no MinIO/LocalStack/S3. All the logic is shipped,
guarded, and unit-proven (31/31), and the exact rehearsal is written as
`rem-04-file-restore-rehearsal.md`. **OPS-002 and OPS-001 stay PARTIALLY CLOSED** until those gates
pass on a real bucket with RTO recorded.
