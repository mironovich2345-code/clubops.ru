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
   * Cheap existence check — does NOT read the object bytes (local: fs stat;
   * s3: HeadObject). Returns false for a malformed key or a missing object.
   * Used to distinguish "metadata present but object gone" from "file present".
   */
  exists(key: string): Promise<boolean>;

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

  /**
   * Object metadata without reading the bytes: existence + size (and ETag when the
   * backend provides one). Returns null when the object is absent. Optional — a
   * provider that predates REM-04 may omit it; callers must feature-detect. Used by
   * upload verification (§7) and the file inventory (§11).
   */
  head?(key: string): Promise<{ size: number; etag: string | null } | null>;

  /**
   * Lists object keys under a prefix (paginated by the provider), for the read-only
   * inventory/reconciliation only. Optional. `max` bounds a single page.
   */
  list?(prefix: string, opts?: { max?: number }): Promise<string[]>;
}

/**
 * Rejects keys that could escape the storage root or are malformed. Accepts BOTH
 * the legacy single-subfolder keys ("invoices/<hex>.ext") AND the REM-04 canonical
 * tenant-scoped keys ("<env>/<companyId>/<entityType>/<entityId>/<fileId>/<hash>-<ext>").
 * Every path segment must be non-empty safe chars; no "..", no backslash, no leading
 * slash, no double slash.
 */
export function isSafeStorageKey(key: string): boolean {
  if (!key || key.length > 512) return false;
  if (key.startsWith("/") || key.endsWith("/") || key.includes("//")) return false;
  if (key.includes("..") || key.includes("\\")) return false;
  // one-or-more "safechars/" segments followed by a final safechars segment.
  return /^([a-z0-9._-]+\/)+[a-z0-9._-]+$/i.test(key);
}
