// REM-03 — backup:list. READ-ONLY off-site backup catalog (no credentials shown). Lists dumps under the
// configured prefix with manifest metadata (timestamp, type, environment, size, sha availability,
// deploymentVersion, age, restore-tested status). Requires the BACKUP_S3_* env + the S3 SDK.
//   node scripts/backup-list.mjs [--json] [--limit=50]
import { validateBackupEnv, redactSecrets } from "./lib/backup-core.mjs";
const env = process.env;
const JSON_ONLY = process.argv.includes("--json");
const limit = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1] || 50);

async function main() {
  const chk = validateBackupEnv(env, { requireS3: true });
  if (!chk.ok) { console.error(redactSecrets(`backup env invalid: ${chk.errors.join("; ")}`, env)); process.exit(1); }
  const cfg = chk.config;
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle, credentials: { accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY } });
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: cfg.prefix || undefined, MaxKeys: 1000 }));
  const dumps = (listed.Contents || []).filter((o) => o.Key.endsWith("-db.dump")).sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0)).slice(0, limit);
  const rows = [];
  for (const d of dumps) {
    let manifest = null;
    try { const r = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: d.Key + ".manifest.json" })); manifest = JSON.parse(await r.Body.transformToString()); } catch {}
    rows.push({ key: d.Key, sizeBytes: d.Size, lastModified: d.LastModified, ageHours: d.LastModified ? Math.round((Date.now() - d.LastModified.getTime()) / 3.6e6) : null, type: manifest?.backupType ?? null, environment: manifest?.environment ?? null, deploymentVersion: manifest?.deploymentVersion ?? null, hasManifest: !!manifest, restoreTestedAt: manifest?.restoreTestedAt ?? null, restoreTestResult: manifest?.restoreTestResult ?? null });
  }
  if (JSON_ONLY) { console.log(JSON.stringify({ bucket: cfg.bucket, prefix: cfg.prefix, count: rows.length, rows }, null, 2)); return; }
  console.log(`=== Backup catalog (${rows.length}) — ${cfg.bucket}/${cfg.prefix || ""} ===`);
  for (const r of rows) console.log(`${r.lastModified?.toISOString() ?? "?"} [${r.type ?? "?"}] ${r.key}  ${r.sizeBytes}B  age=${r.ageHours}h  restoreTested=${r.restoreTestResult ?? "no"}`);
}
main().catch((e) => { console.error(redactSecrets(String(e?.message || e), env)); process.exit(1); });
