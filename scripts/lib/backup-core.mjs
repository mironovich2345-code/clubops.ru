// REM-03 — pure, dependency-light backup helpers shared by the backup/restore CLIs and their tests.
// No DB, no S3, no side effects here — just validation, key/manifest construction, checksum, and secret
// redaction. Kept as plain .mjs so a cron/systemd job runs it with zero build step.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const BACKUP_FORMAT_VERSION = "rem-03.v1";
export const MIN_DUMP_BYTES = 512; // a real pg_dump -Fc header alone exceeds this; smaller ⇒ suspicious

// The env vars the S3 off-site target requires (provider-neutral).
export const REQUIRED_S3_ENV = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_REGION", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"];
export const SECRET_ENV = ["BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_S3_ACCESS_KEY_ID", "DATABASE_URL", "POSTGRES_PASSWORD"];

/** Validate the backup env contract. In production a scheduled/off-site backup requires the full S3
 * config → fail-fast. Returns { ok, errors, config } with NO secret values echoed. */
export function validateBackupEnv(env, { requireS3 = true, isProduction = false } = {}) {
  const errors = [];
  if (requireS3) for (const k of REQUIRED_S3_ENV) if (!env[k] || String(env[k]).trim() === "") errors.push(`${k} is required`);
  const bucket = env.BACKUP_S3_BUCKET || "";
  if (requireS3 && /public|www|cdn/i.test(bucket)) errors.push("BACKUP_S3_BUCKET name looks public — the backup bucket must be private");
  const retention = Number(env.BACKUP_RETENTION_DAYS ?? 14);
  if (!Number.isFinite(retention) || retention < 1) errors.push("BACKUP_RETENTION_DAYS must be a positive integer");
  const enc = env.BACKUP_ENCRYPTION_MODE || "sse-s3";
  if (!["sse-s3", "sse-kms", "none"].includes(enc)) errors.push("BACKUP_ENCRYPTION_MODE must be sse-s3 | sse-kms | none");
  if (isProduction && enc === "none") errors.push("BACKUP_ENCRYPTION_MODE=none is not allowed in production");
  return {
    ok: errors.length === 0,
    errors,
    config: { endpoint: env.BACKUP_S3_ENDPOINT, region: env.BACKUP_S3_REGION, bucket, prefix: env.BACKUP_S3_PREFIX || "", forcePathStyle: /^true$/i.test(env.BACKUP_S3_FORCE_PATH_STYLE || ""), retentionDays: retention, encryption: enc, environment: env.BACKUP_ENVIRONMENT || (isProduction ? "production" : "unknown") },
  };
}

/** Validate DATABASE_URL for backup/restore (closes the backup half of OPS-013). Never prints the URL. */
export function validateDatabaseUrl(url, { isProduction = false, allowLocalhost = false } = {}) {
  if (!url || String(url).trim() === "") return { ok: false, provider: null, error: "DATABASE_URL is empty" };
  if (/^file:/i.test(url)) return { ok: false, provider: "sqlite", error: "DATABASE_URL is a sqlite file: URL — refusing (backup/restore is PostgreSQL only)" };
  if (!/^postgres(ql)?:\/\//i.test(url)) return { ok: false, provider: "unknown", error: "DATABASE_URL scheme is not postgresql:// or postgres://" };
  if (isProduction && !allowLocalhost && /@(localhost|127\.0\.0\.1)[:/]/i.test(url)) return { ok: false, provider: "postgresql", error: "DATABASE_URL points at localhost in production (set allowLocalhost only if intentional)" };
  return { ok: true, provider: "postgresql", error: null };
}

const pad = (n) => String(n).padStart(2, "0");
/** Collision-safe, secret-free object key. `now` is passed in (deterministic for tests). */
export function buildObjectKey({ environment, now, deploymentVersion, prefix = "", ext = "db.dump" }) {
  const d = now;
  const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const ver = (deploymentVersion || "unknown").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "unknown";
  const base = `${environment}/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${ts}-${ver}-${ext}`;
  return (prefix ? prefix.replace(/\/+$/, "") + "/" : "") + base;
}

/** Build the manifest. Throws if any secret-looking value would be embedded (defence in depth). */
export function buildManifest(m) {
  const manifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    backupId: m.backupId,
    backupType: m.backupType, // scheduled | pre-deploy | manual | pre-financial-migration
    environment: m.environment,
    createdAt: m.createdAt,
    completedAt: m.completedAt,
    deploymentVersion: m.deploymentVersion ?? null,
    gitCommit: m.gitCommit ?? null,
    databaseProvider: "postgresql",
    postgresServerVersion: m.postgresServerVersion ?? null,
    pgDumpVersion: m.pgDumpVersion ?? null,
    schemaMigrationCount: m.schemaMigrationCount ?? null,
    latestMigration: m.latestMigration ?? null,
    dumpSizeBytes: m.dumpSizeBytes ?? null,
    sha256: m.sha256 ?? null,
    criticalRowCounts: m.criticalRowCounts ?? {},
    criticalMoneyChecksums: m.criticalMoneyChecksums ?? {},
    encryption: m.encryption ?? null,
    storageProvider: "s3-compatible",
    objectKey: m.objectKey ?? null,
    restoreTestedAt: m.restoreTestedAt ?? null,
    restoreTestResult: m.restoreTestResult ?? null,
  };
  const serialized = JSON.stringify(manifest);
  // No secret values (a leaked key/password/URL must never land in a stored manifest).
  for (const bad of [/postgres(ql)?:\/\/[^"\s]+/i, /"password"/i, /AKIA[0-9A-Z]{16}/, /BEGIN [A-Z ]*PRIVATE KEY/]) {
    if (bad.test(serialized)) throw new Error("manifest would contain a secret-looking value — refusing");
  }
  return manifest;
}

/** Redact secret values from a log/error string (never leak keys/URLs). */
export function redactSecrets(text, env = {}) {
  let out = String(text);
  for (const k of SECRET_ENV) { const v = env[k]; if (v && String(v).length >= 6) out = out.split(String(v)).join(`<${k}>`); }
  out = out.replace(/postgres(ql)?:\/\/[^\s"']+/gi, "postgresql://<redacted>");
  out = out.replace(/AKIA[0-9A-Z]{16}/g, "<access-key>");
  return out;
}

/** SHA-256 of a file (streamed). */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("error", reject);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** Is a target DATABASE_URL a safe RESTORE target? Production is refused unless an explicit disposable
 * confirmation token is present. Returns { ok, reason }. */
export function isSafeRestoreTarget(url, { confirmDisposable = false, isProduction = false } = {}) {
  const v = validateDatabaseUrl(url, { isProduction: false, allowLocalhost: true });
  if (!v.ok) return { ok: false, reason: v.error };
  if (isProduction) return { ok: false, reason: "restore refuses a production target — use a disposable/staging DB" };
  if (!confirmDisposable) return { ok: false, reason: "restore requires --confirm-disposable (it will populate the target DB)" };
  return { ok: true, reason: null };
}
