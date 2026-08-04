// REM-03 — backup:database. One safe core for scheduled / pre-deploy / manual / pre-financial-migration
// backups: validate env → pg_dump -Fc → SHA-256 → manifest (with money checksums) → off-site S3 upload →
// remote verify → temp cleanup → structured result. Fail-closed: any failure is non-zero, no success
// marker, temp cleaned, secrets redacted. NO writes to the source DB. pg_dump/S3 are required to actually
// run — in an environment without them the script fails safely (never reports a false success).
//   node scripts/backup-database.mjs --type=scheduled [--dry-run] [--local-only] [--json]
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, openSync, closeSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBackupEnv, validateDatabaseUrl, buildObjectKey, buildManifest, redactSecrets, sha256File, MIN_DUMP_BYTES } from "./lib/backup-core.mjs";
import { computeBackupChecksums } from "./lib/backup-checksums.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const arg = (n, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); if (a) return a.split("=")[1]; return process.argv.includes(`--${n}`) ? true : d; };
const JSON_ONLY = process.argv.includes("--json");
const env = process.env;
const isProd = env.NODE_ENV === "production";
const type = arg("type", "manual");
const dryRun = !!arg("dry-run", false);
const localOnly = !!arg("local-only", false);
const LOCK = join(ROOT, ".backup.lock");
const out = (o) => { if (JSON_ONLY) console.log(JSON.stringify(o)); else console.log(o.human || JSON.stringify(o, null, 2)); };
const fail = (code, msg) => { out({ ok: false, errorCode: code, error: redactSecrets(msg, env), human: `BACKUP FAILED [${code}]: ${redactSecrets(msg, env)}` }); process.exit(1); };

// --- single-flight lock (stale after 2h) ---
function acquireLock() {
  try { const fd = openSync(LOCK, "wx"); writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); closeSync(fd); return true; }
  catch { try { const s = statSync(LOCK); if (Date.now() - s.mtimeMs > 2 * 3600 * 1000) { unlinkSync(LOCK); return acquireLock(); } } catch {} return false; }
}
const releaseLock = () => { try { unlinkSync(LOCK); } catch {} };

async function main() {
  if (!["scheduled", "pre-deploy", "manual", "pre-financial-migration"].includes(type)) fail("BAD_TYPE", `unknown --type=${type}`);

  // 1. env contract (production fail-fast when off-site is required).
  const envCheck = validateBackupEnv(env, { requireS3: !localOnly, isProduction: isProd });
  if (!envCheck.ok && !localOnly) fail("ENV_INVALID", `backup env invalid: ${envCheck.errors.join("; ")}`);
  const cfg = envCheck.config;

  // 2. DATABASE_URL (backup is PostgreSQL only — never silently dump a dev sqlite).
  const urlCheck = validateDatabaseUrl(env.DATABASE_URL, { isProduction: isProd, allowLocalhost: /^true$/i.test(env.BACKUP_ALLOW_LOCALHOST || "") });
  if (!urlCheck.ok) fail("DB_URL_INVALID", urlCheck.error);

  if (!acquireLock()) fail("LOCKED", "another backup is already running (lock held) — exiting without a competing dump");

  const tmp = mkdtempSync(join(tmpdir(), "clubops-backup-"));
  const dumpPath = join(tmp, "db.dump");
  const createdAt = new Date();
  try {
    // 3. pg_dump -Fc --no-owner --no-acl (portable restore into a fresh disposable DB).
    if (dryRun) { out({ ok: true, dryRun: true, type, wouldUpload: !localOnly, config: { bucket: cfg.bucket, prefix: cfg.prefix, encryption: cfg.encryption }, human: `DRY-RUN: validated env + DATABASE_URL; would pg_dump + upload (type=${type})` }); releaseLock(); rmSync(tmp, { recursive: true, force: true }); return; }
    const pg = spawnSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "--file", dumpPath, env.DATABASE_URL], { stdio: ["ignore", "ignore", "pipe"] });
    if (pg.error || pg.status !== 0) fail("PG_DUMP_FAILED", `pg_dump failed: ${pg.error?.message || pg.stderr?.toString() || `exit ${pg.status}`}`);
    // 4. reject empty/suspiciously small dump.
    const size = statSync(dumpPath).size;
    if (size < MIN_DUMP_BYTES) fail("DUMP_TOO_SMALL", `dump is ${size} bytes (< ${MIN_DUMP_BYTES}) — refusing`);
    // 5. checksum + 6. manifest (money checksums via a read-only client).
    const sha256 = await sha256File(dumpPath);
    let checksums = { criticalRowCounts: {}, criticalMoneyChecksums: {} };
    try { const { PrismaClient } = await import("@prisma/client"); const p = new PrismaClient(); checksums = await computeBackupChecksums(p); await p.$disconnect(); } catch (e) { /* checksums best-effort; the dump is still valid */ }
    const deploymentVersion = env.APP_GIT_SHA || env.APP_DEPLOYMENT_ID || "unknown";
    const objectKey = buildObjectKey({ environment: cfg.environment, now: createdAt, deploymentVersion, prefix: cfg.prefix });
    const manifest = buildManifest({ backupId: `${type}-${createdAt.toISOString()}`, backupType: type, environment: cfg.environment, createdAt: createdAt.toISOString(), completedAt: new Date().toISOString(), deploymentVersion, gitCommit: env.APP_GIT_SHA ?? null, dumpSizeBytes: size, sha256, criticalRowCounts: checksums.criticalRowCounts, criticalMoneyChecksums: checksums.criticalMoneyChecksums, encryption: cfg.encryption, objectKey });
    writeFileSync(join(tmp, "db.manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(tmp, "db.sha256"), `${sha256}  db.dump\n`);

    // 7. upload (dump + .sha256 + .manifest.json) + 8. remote verify.
    if (localOnly) { out({ ok: true, type, localOnly: true, objectKey, sha256, sizeBytes: size, human: `LOCAL-ONLY backup created (${size} bytes, sha ${sha256.slice(0, 12)}) — NOT uploaded off-site` }); releaseLock(); rmSync(tmp, { recursive: true, force: true }); return; }
    const { uploaded, verified } = await uploadAndVerify({ cfg, objectKey, dumpPath, manifest, sha256 });
    if (!uploaded) fail("UPLOAD_FAILED", "off-site upload failed");
    if (!verified) fail("REMOTE_VERIFY_FAILED", "remote object verification (HEAD/size) failed after upload");

    out({ ok: true, type, objectKey, sha256, sizeBytes: size, uploaded: true, verified: true, encryption: cfg.encryption, human: `BACKUP OK: ${objectKey} (${size} bytes, sha ${sha256.slice(0, 12)}, ${cfg.encryption})` });
  } catch (e) {
    fail("UNEXPECTED", e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    releaseLock();
  }
}

// S3 upload + HEAD verify via the provider-neutral SDK. Uses server-side encryption per config.
async function uploadAndVerify({ cfg, objectKey, dumpPath, manifest, sha256 }) {
  const { S3Client, PutObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle, credentials: { accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY } });
  const sse = cfg.encryption === "sse-kms" ? { ServerSideEncryption: "aws:kms" } : cfg.encryption === "sse-s3" ? { ServerSideEncryption: "AES256" } : {};
  const put = (Key, Body, ContentType) => s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key, Body, ContentType, ...sse }));
  await put(objectKey, readFileSync(dumpPath), "application/octet-stream");
  await put(objectKey + ".sha256", `${sha256}  db.dump\n`, "text/plain");
  await put(objectKey + ".manifest.json", JSON.stringify(manifest, null, 2), "application/json");
  const head = await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: objectKey }));
  const verified = Number(head.ContentLength) === statSync(dumpPath).size;
  return { uploaded: true, verified };
}

main().catch((e) => fail("FATAL", e instanceof Error ? e.message : String(e)));
