// Storage provider abstraction. Files are addressed by an opaque, validated
// `key` like "invoices/<32 hex>.jpg". Providers never expose absolute paths or
// credentials to callers; the app streams bytes through scoped download routes.

export type StorageProviderName = "local" | "s3";

export interface StorageProvider {
  readonly name: StorageProviderName;

  /** Stores bytes under `key` (overwrites). */
  put(key: string, buffer: Buffer, mime: string): Promise<void>;

  /** Returns the bytes, or null if the object does not exist. */
  get(key: string): Promise<Buffer | null>;

  /**
   * A time-limited direct URL for the object, or null when the provider has no
   * notion of one (local disk). Most callers stream through the app's download
   * routes instead, so access control and audit stay server-side.
   */
  getSignedUrl(
    key: string,
    opts?: { expiresInSeconds?: number; downloadName?: string },
  ): Promise<string | null>;

  /** Removes the object. Missing objects are treated as already deleted. */
  delete(key: string): Promise<void>;
}

/** Rejects keys that could escape the storage root or are malformed. */
export function isSafeStorageKey(key: string): boolean {
  if (!key || key.length > 256) return false;
  if (key.startsWith("/") || key.includes("..") || key.includes("\\")) return false;
  // category/<hex-or-name>.<ext> — keep it to a single subfolder of safe chars.
  return /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(key);
}
