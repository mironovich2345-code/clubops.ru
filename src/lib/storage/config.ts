// Storage configuration contract + validation (REM-04 §3/§4/§23).
//
// One source of truth for "is object storage correctly configured?". The core
// `validateStorageEnv(env, {isProduction})` is PURE (takes an env bag, returns a
// value-free result) so it is unit-tested without touching process.env or the
// network. `assertStorageConfigured()` reads process.env and FAILS FAST — in
// production a `local` provider (or an incomplete S3 config) throws, so the app
// cannot start on ephemeral disk (closes ARCH-017 / OPS-002 at the config layer).
//
// Secrets (access key / secret key) are NEVER returned in any result object and
// NEVER appear in an error — only variable NAMES and non-secret settings.

export type StorageProviderName = "local" | "s3";

export type StorageEnv = Record<string, string | undefined>;

export type ResolvedS3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  prefix: string; // may be "" (no prefix)
  serverSideEncryption: "AES256" | "aws:kms";
  kmsKeyId: string | null;
  // Presence flags only — the values are read directly by the provider, never
  // surfaced here.
  hasAccessKeyId: boolean;
  hasSecretAccessKey: boolean;
};

export type StorageValidation = {
  ok: boolean;
  provider: StorageProviderName;
  errors: string[]; // machine codes, secret-free
  environment: string;
  signedUrlTtlSeconds: number;
  maxFileSizeBytes: number;
  s3: ResolvedS3Config | null;
};

export const DEFAULT_SIGNED_URL_TTL = 300; // 5 min
export const MAX_SIGNED_URL_TTL = 3600; // 1 h ceiling
export const DEFAULT_MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB (>= the largest per-module cap)

/** First non-empty of the given env names (new STORAGE_S3_* preferred, legacy S3_* fallback). */
function pick(env: StorageEnv, ...names: string[]): string {
  for (const n of names) {
    const v = env[n];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

function parseBool(v: string, dflt: boolean): boolean {
  if (v === "") return dflt;
  return v === "true" || v === "1" || v.toLowerCase() === "yes";
}

function parseIntOr(v: string, dflt: number): number {
  if (v === "") return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Validate the storage env. PURE — no process.env, no I/O. `isProduction` drives
 * the fail-fast rules (production must use S3 with a complete config).
 */
export function validateStorageEnv(env: StorageEnv, opts: { isProduction: boolean }): StorageValidation {
  const errors: string[] = [];
  const provider: StorageProviderName = env.STORAGE_PROVIDER === "s3" ? "s3" : "local";
  const environment = pick(env, "STORAGE_ENVIRONMENT", "APP_ENV", "NODE_ENV") || "development";

  // --- signed-URL TTL + max size (apply to both providers) ---
  const ttl = parseIntOr(pick(env, "STORAGE_SIGNED_URL_TTL_SECONDS"), DEFAULT_SIGNED_URL_TTL);
  if (!Number.isFinite(ttl) || ttl <= 0) errors.push("SIGNED_URL_TTL_INVALID");
  else if (ttl > MAX_SIGNED_URL_TTL) errors.push("SIGNED_URL_TTL_TOO_LONG");
  const signedUrlTtlSeconds = Number.isFinite(ttl) && ttl > 0 && ttl <= MAX_SIGNED_URL_TTL ? ttl : DEFAULT_SIGNED_URL_TTL;

  const maxSize = parseIntOr(pick(env, "STORAGE_MAX_FILE_SIZE_BYTES"), DEFAULT_MAX_FILE_SIZE);
  if (!Number.isFinite(maxSize) || maxSize <= 0) errors.push("MAX_FILE_SIZE_INVALID");
  const maxFileSizeBytes = Number.isFinite(maxSize) && maxSize > 0 ? maxSize : DEFAULT_MAX_FILE_SIZE;

  // --- production must not use local storage (ARCH-017 / OPS-002) ---
  if (opts.isProduction && provider !== "s3") {
    errors.push("PRODUCTION_LOCAL_FORBIDDEN");
  }

  // --- S3 config (validated whenever the provider is s3, in any environment) ---
  let s3: ResolvedS3Config | null = null;
  if (provider === "s3") {
    const endpoint = pick(env, "STORAGE_S3_ENDPOINT", "S3_ENDPOINT");
    const region = pick(env, "STORAGE_S3_REGION", "S3_REGION") || "ru-central1";
    const bucket = pick(env, "STORAGE_S3_BUCKET", "S3_BUCKET");
    const hasAccessKeyId = pick(env, "STORAGE_S3_ACCESS_KEY_ID", "S3_ACCESS_KEY_ID") !== "";
    const hasSecretAccessKey = pick(env, "STORAGE_S3_SECRET_ACCESS_KEY", "S3_SECRET_ACCESS_KEY") !== "";
    const forcePathStyle = parseBool(pick(env, "STORAGE_S3_FORCE_PATH_STYLE"), true);
    const prefix = pick(env, "STORAGE_S3_PREFIX").replace(/^\/+|\/+$/g, "");
    const sseRaw = pick(env, "STORAGE_S3_SERVER_SIDE_ENCRYPTION") || "AES256";
    const serverSideEncryption: "AES256" | "aws:kms" = sseRaw === "aws:kms" ? "aws:kms" : "AES256";
    const kmsKeyId = pick(env, "STORAGE_S3_KMS_KEY_ID") || null;

    const missing: string[] = [];
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

  return { ok: errors.length === 0, provider, errors, environment, signedUrlTtlSeconds, maxFileSizeBytes, s3 };
}

/** Reads process.env with the current NODE_ENV. */
export function resolveStorageConfig(): StorageValidation {
  return validateStorageEnv(process.env as StorageEnv, { isProduction: process.env.NODE_ENV === "production" });
}

let asserted = false;

/**
 * FAIL FAST: throws (secret-free) when storage is misconfigured for the current
 * environment. Called at startup and by getStorage() in production. Idempotent —
 * only the first call does the work; later calls are cheap when already valid.
 */
export function assertStorageConfigured(): void {
  if (asserted) return;
  const v = resolveStorageConfig();
  if (!v.ok) {
    throw new Error(
      `Storage is misconfigured (${v.provider}); refusing to continue: ${v.errors.join("; ")}`,
    );
  }
  asserted = true;
}

/** SAFE, value-free config summary for /api/health and diagnostics. Never a secret. */
export function storageConfigDiagnostic(): {
  provider: StorageProviderName;
  ok: boolean;
  environment: string;
  s3Configured: boolean;
  serverSideEncryption: string | null;
  forcePathStyle: boolean | null;
  prefix: boolean;
  signedUrlTtlSeconds: number;
  maxFileSizeBytes: number;
  errors: string[];
} {
  const v = resolveStorageConfig();
  return {
    provider: v.provider,
    ok: v.ok,
    environment: v.environment,
    s3Configured: Boolean(v.s3 && v.s3.endpoint && v.s3.bucket && v.s3.hasAccessKeyId && v.s3.hasSecretAccessKey),
    serverSideEncryption: v.s3?.serverSideEncryption ?? null,
    forcePathStyle: v.s3?.forcePathStyle ?? null,
    prefix: Boolean(v.s3?.prefix),
    signedUrlTtlSeconds: v.signedUrlTtlSeconds,
    maxFileSizeBytes: v.maxFileSizeBytes,
    errors: v.errors,
  };
}
