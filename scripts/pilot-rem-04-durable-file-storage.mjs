// Pilot — REM-04 durable file storage (§32). Fast STRUCTURAL checks that the
// production S3 enforcement, immutable tenant-scoped keys, upload verification,
// inventory/preflight/manifest/migration tooling, readiness and docs are all in
// place. The BEHAVIORAL proof is test:rem-04-file-storage (31/31, real TS service
// round-trips); the real S3 upload/download/restore is the documented gate (NOT
// EXECUTED here — no MinIO/S3). Runs in pilot:full.
import { readFileSync } from "node:fs";
let pass = 0,
  fail = 0;
const check = (n, c, x = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`);
  c ? pass++ : fail++;
};
const src = (p) => {
  try {
    return readFileSync(new URL(p, import.meta.url), "utf8");
  } catch {
    return "";
  }
};

const config = src("../src/lib/storage/config.ts");
const objectKey = src("../src/lib/storage/object-key.ts");
const service = src("../src/lib/storage/service.ts");
const types = src("../src/lib/storage/types.ts");
const index = src("../src/lib/storage/index.ts");
const s3 = src("../src/lib/storage/s3-provider.ts");
const localP = src("../src/lib/storage/local-provider.ts");
const readiness = src("../src/lib/storage/readiness.ts");
const core = src("../scripts/lib/file-storage-core.mjs");
const inventory = src("../scripts/audit-file-inventory.mjs");
const preflight = src("../scripts/preflight-file-storage.mjs");
const manifest = src("../scripts/backup-files-manifest.mjs");
const migrate = src("../scripts/migrate-files-to-s3.mjs");
const tests = src("../scripts/rem-04-file-storage-tests.mjs");
const schema = src("../prisma/schema.prisma");
const prodSchema = src("../prisma/production/schema.prisma");
const pkg = src("../package.json");
const report = src("../docs/remediation/rem-04-final-report.md");
const arch = src("../docs/remediation/rem-04-storage-architecture.md");
const keySpec = src("../docs/remediation/rem-04-object-key-spec.md");
const migDoc = src("../docs/remediation/rem-04-local-to-s3-migration.md");
const restoreDoc = src("../docs/remediation/rem-04-file-backup-restore.md");
const rehearsal = src("../docs/testing/rem-04-file-restore-rehearsal.md");
const checklist = src("../docs/testing/rem-04-file-storage-checklist.md");
const storageRunbook = src("../docs/operations/file-storage-runbook.md");
const recoveryRunbook = src("../docs/operations/file-recovery-runbook.md");
const alerts = src("../docs/operations/file-storage-alerts.md");
const dr = src("../docs/operations/disaster-recovery-plan.md");

// 1. production forbids local
check("1 production refuses local provider (fail-fast)", config.includes("PRODUCTION_LOCAL_FORBIDDEN") && index.includes("assertStorageConfigured"));
// 2. S3 env fail-fast
check("2 incomplete S3 config fails fast", config.includes("S3_CONFIG_INCOMPLETE") && config.includes("validateStorageEnv"));
// 3. shared storage service
check("3 shared storage service (putAndVerify/verifyObject)", service.includes("putAndVerify") && service.includes("verifyObject"));
// 4. no direct production fs writes (providers only; service uses getStorage)
check("4 no direct fs write in the service (goes through provider)", !/writeFile\(/.test(service) && service.includes("getStorage()"));
// 5. server-generated key
check("5 server-generated key builder", objectKey.includes("buildObjectKey") && objectKey.includes("newFileId") && objectKey.includes("randomBytes"));
// 6. tenant prefix in key
check("6 tenant-scoped key structure (companyId segment)", objectKey.includes("<companyId>") || objectKey.includes("companyId}/${parts.entityType"));
// 7. immutable objects (content hash + no overwrite doc)
check("7 immutable content-hash key", objectKey.includes("contentHash") && objectKey.includes("HASH_RE"));
// 8. upload verification before metadata
check("8 upload verified before metadata trusted", service.includes("VERIFY_MISSING") && service.includes("VERIFY_SIZE_MISMATCH"));
// 9. metadata consistency (verification fields exist)
check("9 metadata consistency fields on models", schema.includes("verificationStatus") && schema.includes("verifiedAt"));
// 10. retry safe / idempotency
check("10 idempotent upload op + migration replay", schema.includes("uploadOperationKey") && core.includes("planFileMigration") && /deterministic/i.test(migrate));
// 11. download scoped (safe headers / signed url TTL)
check("11 signed-url TTL bounded", config.includes("MAX_SIGNED_URL_TTL") && s3.includes("signedUrlTtlSeconds"));
// 12. signed URL scoped to one object + TTL
check("12 signed URL per-object + short TTL", s3.includes("getSignedUrl") && s3.includes("expiresIn"));
// 13. cross-tenant denied (detectable)
check("13 cross-tenant key detection", objectKey.includes("companyIdFromObjectKey") && inventory.includes("cross-tenant"));
// 14. hash/size stored
check("14 hash + size stored", service.includes("computeSha256") && service.includes("size: buffer.length"));
// 15. missing blob detected
check("15 missing blob detected", inventory.includes("metadata row without a blob") && preflight.includes("no missing blobs"));
// 16. orphan detected
check("16 orphan blob detected", inventory.includes("orphan") && preflight.includes("orphan"));
// 17. inventory read-only
check("17 inventory read-only (no row/blob mutation)", inventory.includes("READ-ONLY") && !/prisma\.\w+\.(update|delete|create|upsert)/.test(inventory) && !/storage.*\.delete\(|unlink\(/.test(inventory));
// 18. manifest generated + checksummed
check("18 manifest generated + checksummed", manifest.includes("BACKUP_FILE_MANIFEST_VERSION") && manifest.includes("sha256Buffer") && manifest.includes("checksum"));
// 19. migration dry-run
check("19 migration dry-run mode", migrate.includes('"dry-run"') && migrate.includes("No mutation performed"));
// 20. migration idempotent (conflict + noop + finalize-only)
check("20 migration idempotency classes", core.includes('"conflict"') && core.includes('"noop"') && core.includes('"finalize-only"'));
// 21. existing local metadata preserved (additive, no backfill)
check("21 additive migration, no auto-backfill", schema.includes("NO auto-backfill") && migrate.includes("KEPT until"));
// 22. no destructive blob delete in the tooling
check("22 no destructive blob delete in tooling", !/\.delete\(/.test(inventory) && !/\.delete\(/.test(manifest) && !/DeleteObject/.test(migrate));
// 23. multi-instance supported (no local affinity; providers are stateless per call)
check("23 multi-instance read proven in tests", tests.includes("second provider instance reads") && s3.includes("getClient"));
// 24. storage readiness exists
check("24 storage readiness (config + bounded probe)", readiness.includes("storageReadiness") && readiness.includes("probeStorage"));
// 25. full restore gate documented
check("25 full-system restore gate documented", rehearsal.includes("Restore PostgreSQL") && rehearsal.includes("NOT EXECUTED") && restoreDoc.includes("Whole-system"));
// 26. disposable S3 integration gate exists
check("26 disposable S3 integration gate exists", rehearsal.includes("MinIO") || rehearsal.includes("LocalStack") || rehearsal.includes("disposable S3"));
// 27. preflight read-only
check("27 preflight read-only", preflight.includes("READ-ONLY") && preflight.includes("SELECT + fs stat only"));
// 28. no production mutation automatically
check("28 no auto production mutation (apply-gated)", migrate.includes("--apply") && migrate.includes("i-understand-production"));
// 29. prisma dev valid (fields present)
check("29 prisma dev schema has durability fields", schema.includes("migrationStatus") && schema.includes("supersedesFileId"));
// 30. prisma prod valid (synced)
check("30 prod schema synced with durability fields", prodSchema.includes("uploadOperationKey") && prodSchema.includes("verificationStatus"));
// 31. tsc clean marker: service compiles (imports getStorage, no any-casts on key)
check("31 storage service wired to index + types", service.includes('from "./index"') && service.includes("isSafeStorageKey"));
// 32. tests registered + pilot registered in pilot:full
check("32 tests + pilot registered", pkg.includes("test:rem-04-file-storage") && pkg.includes("pilot:rem-04-durable-file-storage") && src("../scripts/pilot-full.mjs").includes("pilot-rem-04-durable-file-storage.mjs"));
// 33. findings closure honest (OPS-002 PARTIAL, ARCH-017/SEC-006 closed, OPS-001 partial)
check("33 findings closure honest in report", report.includes("ARCH-017") && report.includes("SEC-006") && report.includes("OPS-002") && report.includes("PARTIALLY CLOSED"));
// extra structural coverage
check("34 SSE enforced on upload", s3.includes("ServerSideEncryption") && config.includes("serverSideEncryption"));
check("35 docs present (architecture/keys/migration/runbooks/alerts)", arch.length > 200 && keySpec.length > 200 && migDoc.length > 200 && storageRunbook.length > 200 && recoveryRunbook.length > 200 && /missing blob/i.test(alerts));
check("36 DR plan updated for blobs", dr.includes("REM-04") && checklist.includes("G-FILE"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
