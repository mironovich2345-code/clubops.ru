// REM-04 — file backup CATALOG / manifest (§12/§13). Builds a signed inventory
// manifest of every file blob (fileId, companyId, entityType/entityId, storageKey,
// sha256, size, status, uploadedAt, verifiedAt), cross-checks metadata vs blob
// PRESENCE (it does NOT download every blob), checksums the manifest, and stores it
// OFF-SITE in the backup bucket (separate creds from the app storage bucket) or
// locally for --dry-run/--local-only. Object storage durability does NOT replace a
// manifest: the manifest is what lets a restore verify "every row's blob exists and
// hashes as recorded".
//
//   node --env-file=.env scripts/backup-files-manifest.mjs --type=scheduled [--json]
//   node --env-file=.env scripts/backup-files-manifest.mjs --dry-run --local-only
//
// NO PII / original filenames in the manifest. Secret-free. Fail-closed.
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { validateBackupEnv, redactSecrets } from "./lib/backup-core.mjs";
import { BACKUP_FILE_MANIFEST_VERSION, sha256Buffer } from "./lib/file-storage-core.mjs";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const UPLOAD_ROOT = join(ROOT, "uploads");
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=")[1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);
const TYPE = arg("type", "manual");
const DRY_RUN = has("dry-run");
const LOCAL_ONLY = has("local-only");
const JSON_ONLY = has("json");
const isProduction = process.env.NODE_ENV === "production";

const MODEL_ENTITY = {
  ExpenseDocument: "expense",
  RefundDocument: "refund",
  CashOperationDocument: "cash",
  SalesReportDocument: "sales-report",
  Invoice: "invoice",
};

function fail(code, err) {
  console.error(redactSecrets(`files-manifest FAILED (${code}): ${String(err && err.message ? err.message : err)}`, process.env));
  prisma.$disconnect().finally(() => process.exit(1));
}

async function present(key) {
  try {
    return (await stat(join(UPLOAD_ROOT, key))).isFile();
  } catch {
    return false;
  }
}

async function main() {
  if (!["scheduled", "pre-deploy", "manual"].includes(TYPE)) throw new Error(`unknown --type=${TYPE}`);

  // Collect entries (no PII).
  const entries = [];
  const add = async (model, id, companyId, entityId, storageKey, sha256, size, status, verifiedAt, uploadedAt) => {
    if (!storageKey) return;
    entries.push({
      fileId: id,
      companyId: companyId ?? null,
      entityType: MODEL_ENTITY[model],
      entityId: entityId ?? null,
      storageKey,
      sha256: sha256 ?? null,
      sizeBytes: size ?? null,
      status: status ?? "active",
      blobPresent: await present(storageKey),
      uploadedAt: uploadedAt ? new Date(uploadedAt).toISOString() : null,
      verifiedAt: verifiedAt ? new Date(verifiedAt).toISOString() : null,
    });
  };
  for (const r of await prisma.expenseDocument.findMany())
    await add("ExpenseDocument", r.id, r.companyId, r.expenseId, r.storageKey, r.sha256, r.sizeBytes, r.removedAt ? "removed" : "active", r.verifiedAt, r.createdAt);
  for (const r of await prisma.refundDocument.findMany())
    await add("RefundDocument", r.id, r.companyId, r.refundId, r.storageKey, r.sha256, r.sizeBytes, r.removedAt ? "removed" : "active", r.verifiedAt, r.createdAt);
  for (const r of await prisma.cashOperationDocument.findMany())
    await add("CashOperationDocument", r.id, r.companyId, r.collectionId ?? r.withdrawalId ?? r.otherIncomeId, r.storageKey, r.sha256, r.sizeBytes, r.removedAt ? "removed" : "active", r.verifiedAt, r.createdAt);
  for (const r of await prisma.salesReportDocument.findMany({ include: { report: { select: { companyId: true } } } }))
    await add("SalesReportDocument", r.id, r.report?.companyId, r.salesReportId, r.storageKey, r.sha256, r.originalFileSize, "active", r.verifiedAt, r.createdAt);
  for (const r of await prisma.invoice.findMany({ where: { originalFileStorageKey: { not: null } }, select: { id: true, companyId: true, originalFileStorageKey: true, originalFileSize: true, createdAt: true } }))
    await add("Invoice", r.id, r.companyId, r.id, r.originalFileStorageKey, null, r.originalFileSize, "active", null, r.createdAt);

  // Deterministic order → deterministic checksum.
  entries.sort((a, b) => (a.storageKey < b.storageKey ? -1 : a.storageKey > b.storageKey ? 1 : 0));

  const missing = entries.filter((e) => e.status === "active" && !e.blobPresent).length;
  const manifestBody = {
    manifestVersion: BACKUP_FILE_MANIFEST_VERSION,
    type: TYPE,
    environment: isProduction ? "production" : process.env.STORAGE_ENVIRONMENT || "non-production",
    provider: process.env.STORAGE_PROVIDER === "s3" ? "s3" : "local",
    createdAt: new Date().toISOString(),
    counts: { total: entries.length, active: entries.filter((e) => e.status === "active").length, missingBlobs: missing },
    durabilityAssumptions: {
      bucketVersioning: "REQUIRED (recover an overwritten/deleted object version)",
      lifecycle: "retention via bucket lifecycle; never expire the last version of a financial doc",
      replication: "provider durability + optional cross-region replication (documented in the runbook)",
      credentialSeparation: "manifest stored in the BACKUP bucket (BACKUP_S3_*), NOT the app storage bucket (STORAGE_S3_*)",
    },
    entries,
  };
  const json = JSON.stringify(manifestBody, null, 2);
  // Guard: a manifest must never carry a secret value.
  if (redactSecrets(json, process.env) !== json) throw new Error("manifest contained a secret-looking value — refusing");
  const checksum = sha256Buffer(Buffer.from(json, "utf8"));

  const ts = manifestBody.createdAt.replace(/[:.]/g, "-");
  const baseName = `${manifestBody.environment}-${ts}-files-manifest`;

  // Local artifact (always, unless a pure dry-run that only reports counts).
  let localPath = null;
  if (!DRY_RUN) {
    const dir = join(ROOT, "backups", "files-manifest");
    mkdirSync(dir, { recursive: true });
    localPath = join(dir, `${baseName}.json`);
    writeFileSync(localPath, json);
    writeFileSync(join(dir, `${baseName}.json.sha256`), `${checksum}  ${baseName}.json\n`);
  }

  // Off-site upload (skipped for --dry-run/--local-only). Fail-fast if requested
  // but the backup bucket is not configured.
  let uploaded = false;
  if (!DRY_RUN && !LOCAL_ONLY) {
    const env = validateBackupEnv(process.env, { requireS3: true, isProduction });
    if (!env.ok) throw new Error(`backup bucket not configured: ${env.errors.join("; ")}`);
    const { S3Client, PutObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const cfg = env.config;
    const client = new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle, credentials: { accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY } });
    const prefix = (cfg.prefix ? cfg.prefix + "/" : "") + `files-manifest/${manifestBody.environment}/${ts}`;
    const key = `${prefix}-files-manifest.json`;
    const enc = cfg.encryption === "aws:kms" ? { ServerSideEncryption: "aws:kms" } : { ServerSideEncryption: "AES256" };
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: json, ContentType: "application/json", ...enc }));
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: `${key}.sha256`, Body: `${checksum}  ${key}\n`, ContentType: "text/plain", ...enc }));
    const head = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    if (!head || (head.ContentLength ?? 0) < Buffer.byteLength(json)) throw new Error("remote manifest verify failed (size mismatch)");
    uploaded = true;
  }

  const out = { ok: true, type: TYPE, manifestVersion: BACKUP_FILE_MANIFEST_VERSION, counts: manifestBody.counts, checksum, localPath, uploaded, dryRun: DRY_RUN, localOnly: LOCAL_ONLY };
  if (JSON_ONLY) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`files-manifest (${TYPE}) — ${manifestBody.counts.total} entries, ${missing} missing blob(s)`);
    console.log(`  checksum ${checksum}`);
    console.log(`  ${DRY_RUN ? "dry-run (no file written)" : `local: ${localPath}`}  ${uploaded ? "· uploaded off-site" : LOCAL_ONLY ? "· local-only" : "· NOT uploaded"}`);
  }
  // A manifest that finds missing blobs is a WARNING, not a hard failure of the
  // catalog itself; surface it but do not mask the artifact having been written.
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => fail("RUN", e));
