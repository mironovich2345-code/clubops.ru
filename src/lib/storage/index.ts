import { type StorageProvider, type StorageProviderName } from "./types";
import { createLocalStorageProvider } from "./local-provider";
import { createS3StorageProvider } from "./s3-provider";
import { resolveStorageConfig, assertStorageConfigured } from "./config";

export type { StorageProvider, StorageProviderName } from "./types";
export {
  validateStorageEnv,
  resolveStorageConfig,
  assertStorageConfigured,
  storageConfigDiagnostic,
} from "./config";

/** Configured provider name. Defaults to "local" so dev/test are unchanged. */
export function storageProviderName(): StorageProviderName {
  return process.env.STORAGE_PROVIDER === "s3" ? "s3" : "local";
}

let cached: StorageProvider | null = null;

/**
 * Returns the active storage provider (singleton per server instance).
 *
 * PRODUCTION FAIL-FAST (REM-04 §3/§23, closes ARCH-017 / OPS-002): in production
 * the provider MUST be S3 with a complete config — `assertStorageConfigured()`
 * throws otherwise, so the app can never serve traffic on ephemeral local disk.
 * Development/test keep `local` as the safe default.
 */
export function getStorage(): StorageProvider {
  if (cached) return cached;
  // Throws in production when STORAGE_PROVIDER != s3 or the S3 config is incomplete.
  if (process.env.NODE_ENV === "production") assertStorageConfigured();
  cached = storageProviderName() === "s3" ? createS3StorageProvider() : createLocalStorageProvider();
  return cached;
}

/** Test/diagnostic hook: drop the cached provider so a new config takes effect. */
export function __resetStorageForTests(): void {
  cached = null;
}

/** Re-exported so callers don't import the config module directly. */
export { resolveStorageConfig as storageConfig };
