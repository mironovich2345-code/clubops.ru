import { type StorageProvider, type StorageProviderName } from "./types";
import { createLocalStorageProvider } from "./local-provider";
import { createS3StorageProvider } from "./s3-provider";

export type { StorageProvider, StorageProviderName } from "./types";

/** Configured provider name. Defaults to "local" so dev/Railway are unchanged. */
export function storageProviderName(): StorageProviderName {
  return process.env.STORAGE_PROVIDER === "s3" ? "s3" : "local";
}

let cached: StorageProvider | null = null;

/**
 * Returns the active storage provider (singleton per server instance).
 * STORAGE_PROVIDER=s3 selects S3-compatible object storage (production / RU
 * infrastructure); anything else uses local disk (the safe default).
 */
export function getStorage(): StorageProvider {
  if (cached) return cached;
  cached = storageProviderName() === "s3" ? createS3StorageProvider() : createLocalStorageProvider();
  return cached;
}
