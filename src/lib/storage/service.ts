// Consistent upload/verify helpers (REM-04 §7/§8). The safe flow is:
//   put -> HEAD (or exists) -> assert size matches -> only THEN create/activate
//   the metadata row. This makes "metadata points at a present, correctly-sized
//   blob" a checked invariant instead of a hope, and keeps the network upload
//   OUT of any DB transaction.
//
// Nothing here holds a DB transaction; callers persist metadata after a resolved
// verification. The original filename is never used as a key.

import { createHash } from "node:crypto";
import { getStorage } from "./index";
import { isSafeStorageKey } from "./types";

export function computeSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export type PutAndVerifyResult = {
  key: string;
  size: number;
  sha256: string;
  verified: boolean;
  verificationStatus: "verified";
};

export type StorageWriteError = {
  code: "UNSAFE_KEY" | "WRITE_FAILED" | "VERIFY_MISSING" | "VERIFY_SIZE_MISMATCH";
};

/**
 * Store a validated buffer under a server-generated key and PROVE it landed:
 * writes, then HEADs (falling back to `exists`) and checks the reported size.
 * Throws a classified StorageWriteError on any failure — the caller must NOT
 * mark metadata active if this rejects. Returns the sha256 + size for the row.
 */
export async function putAndVerify(key: string, buffer: Buffer, mime: string): Promise<PutAndVerifyResult> {
  if (!isSafeStorageKey(key)) throw asError("UNSAFE_KEY");
  const storage = getStorage();
  const sha256 = computeSha256(buffer);

  try {
    await storage.put(key, buffer, mime);
  } catch {
    throw asError("WRITE_FAILED");
  }

  // Verify presence + size. Prefer head() (size), fall back to exists().
  if (typeof storage.head === "function") {
    const meta = await storage.head(key);
    if (!meta) throw asError("VERIFY_MISSING");
    // Some backends report 0 for unknown length; only fail on a real mismatch.
    if (meta.size > 0 && meta.size !== buffer.length) throw asError("VERIFY_SIZE_MISMATCH");
  } else {
    const present = await storage.exists(key);
    if (!present) throw asError("VERIFY_MISSING");
  }

  return { key, size: buffer.length, sha256, verified: true, verificationStatus: "verified" };
}

/**
 * Independently re-verify a stored object against an expected size/hash (used by
 * the inventory and restore reconciliation). Returns a value-free verdict.
 */
export async function verifyObject(
  key: string,
  expected: { size?: number; sha256?: string },
): Promise<{ ok: boolean; reason: "ok" | "missing" | "size_mismatch" | "hash_mismatch" | "unsafe_key" }> {
  if (!isSafeStorageKey(key)) return { ok: false, reason: "unsafe_key" };
  const storage = getStorage();
  if (expected.sha256) {
    const bytes = await storage.get(key);
    if (!bytes) return { ok: false, reason: "missing" };
    if (expected.size !== undefined && bytes.length !== expected.size) return { ok: false, reason: "size_mismatch" };
    if (computeSha256(bytes) !== expected.sha256) return { ok: false, reason: "hash_mismatch" };
    return { ok: true, reason: "ok" };
  }
  // Size/existence-only check (no full read).
  if (typeof storage.head === "function") {
    const meta = await storage.head(key);
    if (!meta) return { ok: false, reason: "missing" };
    if (expected.size !== undefined && meta.size > 0 && meta.size !== expected.size) return { ok: false, reason: "size_mismatch" };
    return { ok: true, reason: "ok" };
  }
  const present = await storage.exists(key);
  return present ? { ok: true, reason: "ok" } : { ok: false, reason: "missing" };
}

function asError(code: StorageWriteError["code"]): Error & StorageWriteError {
  const e = new Error(`storage:${code}`) as Error & StorageWriteError;
  e.code = code;
  return e;
}
