// REM-04 — pure file-storage helpers for the cron-safe .mjs tools (inventory,
// preflight, manifest, migration) and the logic tests. NO build step, NO network,
// NO process.env reads (env is passed in). A faithful port of
// src/lib/storage/{config,object-key,types,service}.ts so the tooling enforces the
// exact same rules the app does. Secrets are NEVER returned or logged.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const BACKUP_FILE_MANIFEST_VERSION = "rem-04.v1";
export const DEFAULT_SIGNED_URL_TTL = 300;
export const MAX_SIGNED_URL_TTL = 3600;
export const DEFAULT_MAX_FILE_SIZE = 15 * 1024 * 1024;

// Env names that must never appear in a manifest / log / object key.
export const STORAGE_SECRET_ENV = [
  "STORAGE_S3_SECRET_ACCESS_KEY",
  "STORAGE_S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "DATABASE_URL",
];

function pick(env, ...names) {
  for (const n of names) {
    const v = env[n];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}
function parseBool(v, dflt) {
  if (v === "") return dflt;
  return v === "true" || v === "1" || String(v).toLowerCase() === "yes";
}
function parseIntOr(v, dflt) {
  if (v === "") return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

/** PURE mirror of validateStorageEnv (src/lib/storage/config.ts). */
export function validateStorageEnv(env, opts) {
  const isProduction = Boolean(opts && opts.isProduction);
  const errors = [];
  const provider = env.STORAGE_PROVIDER === "s3" ? "s3" : "local";
  const environment = pick(env, "STORAGE_ENVIRONMENT", "APP_ENV", "NODE_ENV") || "development";

  const ttl = parseIntOr(pick(env, "STORAGE_SIGNED_URL_TTL_SECONDS"), DEFAULT_SIGNED_URL_TTL);
  if (!Number.isFinite(ttl) || ttl <= 0) errors.push("SIGNED_URL_TTL_INVALID");
  else if (ttl > MAX_SIGNED_URL_TTL) errors.push("SIGNED_URL_TTL_TOO_LONG");

  const maxSize = parseIntOr(pick(env, "STORAGE_MAX_FILE_SIZE_BYTES"), DEFAULT_MAX_FILE_SIZE);
  if (!Number.isFinite(maxSize) || maxSize <= 0) errors.push("MAX_FILE_SIZE_INVALID");

  if (isProduction && provider !== "s3") errors.push("PRODUCTION_LOCAL_FORBIDDEN");

  let s3 = null;
  if (provider === "s3") {
    const endpoint = pick(env, "STORAGE_S3_ENDPOINT", "S3_ENDPOINT");
    const region = pick(env, "STORAGE_S3_REGION", "S3_REGION") || "ru-central1";
    const bucket = pick(env, "STORAGE_S3_BUCKET", "S3_BUCKET");
    const hasAccessKeyId = pick(env, "STORAGE_S3_ACCESS_KEY_ID", "S3_ACCESS_KEY_ID") !== "";
    const hasSecretAccessKey = pick(env, "STORAGE_S3_SECRET_ACCESS_KEY", "S3_SECRET_ACCESS_KEY") !== "";
    const forcePathStyle = parseBool(pick(env, "STORAGE_S3_FORCE_PATH_STYLE"), true);
    const prefix = pick(env, "STORAGE_S3_PREFIX").replace(/^\/+|\/+$/g, "");
    const sseRaw = pick(env, "STORAGE_S3_SERVER_SIDE_ENCRYPTION") || "AES256";
    const serverSideEncryption = sseRaw === "aws:kms" ? "aws:kms" : "AES256";
    const kmsKeyId = pick(env, "STORAGE_S3_KMS_KEY_ID") || null;

    const missing = [];
    if (!endpoint) missing.push("STORAGE_S3_ENDPOINT");
    if (!bucket) missing.push("STORAGE_S3_BUCKET");
    if (!hasAccessKeyId) missing.push("STORAGE_S3_ACCESS_KEY_ID");
    if (!hasSecretAccessKey) missing.push("STORAGE_S3_SECRET_ACCESS_KEY");
    if (missing.length) errors.push(`S3_CONFIG_INCOMPLETE:${missing.join(",")}`);
    if (sseRaw !== "AES256" && sseRaw !== "aws:kms") errors.push("SSE_INVALID");
    if (serverSideEncryption === "aws:kms" && !kmsKeyId) errors.push("KMS_KEY_ID_REQUIRED");
    if (prefix.includes("..") || prefix.includes("\\")) errors.push("PREFIX_UNSAFE");
    s3 = { endpoint, region, bucket, forcePathStyle, prefix, serverSideEncryption, kmsKeyId, hasAccessKeyId, hasSecretAccessKey };
  }
  return { ok: errors.length === 0, provider, errors, environment, s3 };
}

// --- object key (mirror of src/lib/storage/object-key.ts) ---
export const OBJECT_ENTITY_TYPES = ["invoice", "expense", "refund", "cash", "sales-report", "payroll", "company", "temp"];
const SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const EXT_RE = /^[a-z0-9]{1,8}$/;
const ENV_RE = /^[a-z0-9-]{1,32}$/;

const MIME_EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv", "application/csv": "csv",
};
export function safeExtensionFromMime(mime) {
  return MIME_EXT[mime] ?? null;
}

export function buildObjectKey(parts) {
  const environment = String(parts.environment).toLowerCase();
  if (!ENV_RE.test(environment)) throw new Error("Unsafe object key: environment");
  if (!SEGMENT_RE.test(parts.companyId)) throw new Error("Unsafe object key: companyId");
  if (!OBJECT_ENTITY_TYPES.includes(parts.entityType)) throw new Error(`Unsafe object key: entityType (${parts.entityType})`);
  if (!SEGMENT_RE.test(parts.entityId)) throw new Error("Unsafe object key: entityId");
  if (!SEGMENT_RE.test(parts.fileId)) throw new Error("Unsafe object key: fileId");
  if (!HASH_RE.test(parts.contentHash)) throw new Error("Unsafe object key: contentHash");
  const ext = String(parts.ext).toLowerCase();
  if (!EXT_RE.test(ext)) throw new Error("Unsafe object key: ext");
  return `${environment}/${parts.companyId}/${parts.entityType}/${parts.entityId}/${parts.fileId}/${parts.contentHash}-${ext}`;
}

export function parseObjectKey(key) {
  if (typeof key !== "string" || key.length > 512 || key.includes("..") || key.includes("\\")) return null;
  const segs = key.split("/");
  if (segs.length !== 6) return null;
  const [environment, companyId, entityType, entityId, fileId, tail] = segs;
  const dash = tail.lastIndexOf("-");
  if (dash <= 0) return null;
  const contentHash = tail.slice(0, dash);
  const ext = tail.slice(dash + 1);
  if (!ENV_RE.test(environment)) return null;
  if (!SEGMENT_RE.test(companyId)) return null;
  if (!OBJECT_ENTITY_TYPES.includes(entityType)) return null;
  if (!SEGMENT_RE.test(entityId)) return null;
  if (!SEGMENT_RE.test(fileId)) return null;
  if (!HASH_RE.test(contentHash)) return null;
  if (!EXT_RE.test(ext)) return null;
  return { environment, companyId, entityType, entityId, fileId, contentHash, ext };
}
export function isTenantScopedObjectKey(key) {
  return parseObjectKey(key) !== null;
}
export function companyIdFromObjectKey(key) {
  const p = parseObjectKey(key);
  return p ? p.companyId : null;
}

/** Mirror of src/lib/storage/types.ts isSafeStorageKey (legacy + tenant keys). */
export function isSafeStorageKey(key) {
  if (!key || key.length > 512) return false;
  if (key.startsWith("/") || key.endsWith("/") || key.includes("//")) return false;
  if (key.includes("..") || key.includes("\\")) return false;
  return /^([a-z0-9._-]+\/)+[a-z0-9._-]+$/i.test(key);
}

/** Redact any known secret VALUE that appears in text; also refuses secret-looking tokens. */
export function redactStorageSecrets(text, env) {
  let out = String(text);
  for (const name of STORAGE_SECRET_ENV) {
    const v = env && env[name];
    if (v && v.length >= 4) out = out.split(v).join(`***${name}***`);
  }
  return out;
}

/** Throws if a manifest value looks like a secret (long high-entropy or a URL with credentials). */
export function assertNoSecretValue(value) {
  const s = String(value);
  if (/:\/\/[^/@\s]+:[^/@\s]+@/.test(s)) throw new Error("manifest value looks like a URL with credentials — refusing");
  if (/^[A-Za-z0-9/+=_-]{40,}$/.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s)) {
    throw new Error("manifest value looks like a secret token — refusing");
  }
  return s;
}

export function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("error", reject);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** Extension from a storage key (server-set), lowercased. */
export function keyExtension(key) {
  const dot = key.lastIndexOf(".");
  const dash = key.lastIndexOf("-");
  // tenant key ends with <hash>-<ext>; legacy ends with .<ext>
  if (dash > dot) return key.slice(dash + 1).toLowerCase();
  return dot >= 0 ? key.slice(dot + 1).toLowerCase() : "";
}

export const INLINE_SAFE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "pdf"]);
export const ALLOWED_EXTS = new Set(["jpg", "jpeg", "png", "webp", "pdf", "xls", "xlsx", "csv", "heic"]);

// --- local -> S3 migration planning (REM-04 §15/§16) ---
//
// The target key is DETERMINISTIC per source row (fileId = row.id), so a replayed
// migration maps a given blob to the SAME object key every time — a retry never
// creates a duplicate object, and a partially-applied migration resumes safely.

export function buildMigrationTargetKey(row, environment) {
  const contentHash = row.localHash || row.sha256;
  return buildObjectKey({
    environment,
    companyId: row.companyId,
    entityType: row.entityType,
    entityId: row.entityId,
    fileId: row.id,
    contentHash,
    ext: keyExtension(row.storageKey),
  });
}

/**
 * PURE migration decision for one file (§16). No I/O — the caller supplies the
 * observed local + remote state. Returns { action, reason, targetKey? } where
 * action ∈ copy | finalize-only | noop | conflict | skip.
 */
export function planFileMigration(row, ctx) {
  const environment = ctx.environment;
  // 1. missing local source (and not already on s3) → cannot migrate.
  if (!row.localPresent && row.storageProvider !== "s3") return { action: "skip", reason: "missing_local" };
  // 2. local integrity broken: recorded hash != actual local bytes.
  if (row.sha256 && row.localHash && row.sha256 !== row.localHash) return { action: "conflict", reason: "local_hash_mismatch_metadata" };
  const contentHash = row.localHash || row.sha256;
  if (!contentHash) return { action: "skip", reason: "no_hash" };

  let targetKey;
  try {
    targetKey = buildMigrationTargetKey({ ...row, localHash: contentHash }, environment);
  } catch {
    return { action: "skip", reason: "unsafe_target_key" };
  }

  // 3. already migrated.
  if (row.storageProvider === "s3") {
    if (row.sha256 && ctx.remoteHash && ctx.remoteHash !== row.sha256) return { action: "conflict", reason: "already_migrated_diff_hash" };
    return { action: "noop", reason: "already_migrated", targetKey: row.storageKey };
  }
  // 4. remote object already exists (a prior interrupted run).
  if (ctx.remoteExists === true) {
    if (ctx.remoteHash && ctx.remoteHash !== contentHash) return { action: "conflict", reason: "remote_exists_diff_hash" };
    return { action: "finalize-only", reason: "remote_exists_resume", targetKey };
  }
  // 5. ready to copy.
  return { action: "copy", reason: "ready", targetKey };
}
