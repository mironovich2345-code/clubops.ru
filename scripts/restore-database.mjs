// REM-03 — restore:database. SAFE restore into a DISPOSABLE PostgreSQL only. Refuses a production target
// by default; requires --confirm-disposable; verifies the backup checksum BEFORE restoring; never DROPs
// production, never runs `migrate reset`. Flow: validate target → download dump/manifest/.sha256 → verify
// checksum → pg_restore into the (empty) target → recompute checksums → compare to the manifest → report.
// pg_restore + S3 are required to actually run; without them the script fails safely (no false success).
//   node scripts/restore-database.mjs --key=<objectKey> --target-url=<disposable-pg-url> --confirm-disposable [--json]
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBackupEnv, isSafeRestoreTarget, sha256File, redactSecrets } from "./lib/backup-core.mjs";
import { compareChecksums } from "./lib/backup-checksums.mjs";

const arg = (n, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); if (a) return a.split("=")[1]; return process.argv.includes(`--${n}`) ? true : d; };
const JSON_ONLY = process.argv.includes("--json");
const env = process.env;
const out = (o) => { if (JSON_ONLY) console.log(JSON.stringify(o)); else console.log(o.human || JSON.stringify(o, null, 2)); };
const fail = (code, msg) => { out({ ok: false, errorCode: code, error: redactSecrets(msg, env), human: `RESTORE FAILED [${code}]: ${redactSecrets(msg, env)}` }); process.exit(1); };

async function main() {
  const key = arg("key");
  const targetUrl = arg("target-url") || env.RESTORE_TARGET_URL;
  const confirmDisposable = !!arg("confirm-disposable", false);
  if (!key) fail("NO_KEY", "provide --key=<objectKey> (from backup:list)");
  if (!targetUrl) fail("NO_TARGET", "provide --target-url=<disposable-pg-url>");

  // Hard guard: never restore over production; require the explicit disposable confirmation.
  const safe = isSafeRestoreTarget(targetUrl, { confirmDisposable, isProduction: env.NODE_ENV === "production" });
  if (!safe.ok) fail("UNSAFE_TARGET", safe.reason);
  if (/prod/i.test(key) && !/^true$/i.test(env.RESTORE_ALLOW_PROD_KEY || "")) fail("PROD_KEY_GUARD", "the selected backup key looks like production data — set RESTORE_ALLOW_PROD_KEY=true only on an isolated forensic host");

  const envCheck = validateBackupEnv(env, { requireS3: true, isProduction: false });
  if (!envCheck.ok) fail("ENV_INVALID", `backup S3 env invalid: ${envCheck.errors.join("; ")}`);
  const cfg = envCheck.config;

  const tmp = mkdtempSync(join(tmpdir(), "clubops-restore-"));
  const dumpPath = join(tmp, "db.dump");
  try {
    // 1. download dump + manifest + .sha256.
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle, credentials: { accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY } });
    const getText = async (k) => { const r = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: k })); return await r.Body.transformToString(); };
    const getBytes = async (k) => { const r = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: k })); return Buffer.from(await r.Body.transformToByteArray()); };
    writeFileSync(dumpPath, await getBytes(key));
    const manifest = JSON.parse(await getText(key + ".manifest.json"));
    const expectedSha = (await getText(key + ".sha256")).trim().split(/\s+/)[0];

    // 2. verify checksum BEFORE restoring (corrupt dump ⇒ abort).
    const actualSha = await sha256File(dumpPath);
    if (actualSha !== expectedSha) fail("CHECKSUM_MISMATCH", `dump checksum ${actualSha.slice(0, 12)} ≠ manifest ${expectedSha.slice(0, 12)} — corrupt/incomplete, refusing`);

    // 3. pg_restore into the (empty) disposable target. --no-owner --no-acl for portability.
    const pr = spawnSync("pg_restore", ["--no-owner", "--no-acl", "--clean", "--if-exists", "--dbname", targetUrl, dumpPath], { stdio: ["ignore", "ignore", "pipe"] });
    if (pr.error || pr.status !== 0) fail("PG_RESTORE_FAILED", `pg_restore failed: ${pr.error?.message || pr.stderr?.toString() || `exit ${pr.status}`}`);

    // 4. recompute checksums on the restored DB and compare to the manifest.
    let restored = { criticalRowCounts: {}, criticalMoneyChecksums: {} };
    try { const { PrismaClient } = await import("@prisma/client"); const p = new PrismaClient({ datasources: { db: { url: targetUrl } } }); const { computeBackupChecksums } = await import("./lib/backup-checksums.mjs"); restored = await computeBackupChecksums(p); await p.$disconnect(); } catch (e) { fail("VERIFY_FAILED", `could not recompute restored checksums: ${e.message}`); }
    const cmp = compareChecksums({ criticalRowCounts: manifest.criticalRowCounts, criticalMoneyChecksums: manifest.criticalMoneyChecksums }, restored);

    out({ ok: cmp.match, key, restored: true, checksumMatch: cmp.match, mismatches: cmp.mismatches, fileBlobsNote: "DB file METADATA restored; uploaded document BLOBS are NOT in the dump (REM-04) — full-system recovery is incomplete until blobs are restored separately.", human: cmp.match ? `RESTORE OK: ${key} — row counts + money aggregates MATCH the manifest. (File blobs not included — see REM-04.)` : `RESTORE COMPLETED but ${cmp.mismatches.length} checksum mismatch(es) — investigate before trusting.` });
    if (!cmp.match) process.exit(1);
  } catch (e) {
    fail("UNEXPECTED", e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch((e) => fail("FATAL", e instanceof Error ? e.message : String(e)));
