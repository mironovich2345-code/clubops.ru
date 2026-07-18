// Storage + validation for cash-operation (инкассация / изъятие) supporting
// documents. Reuses the expense-document validation (declared MIME + magic-byte
// signature + sha256) and the shared storage abstraction. Keys are opaque and
// server-generated; the original filename is NEVER the key. Server-only.
import { randomBytes } from "node:crypto";
import { getStorage } from "@/lib/storage";
import {
  validateDeclaredDocument,
  validateSignature,
  sha256Hex,
  safeFilename,
  canPreviewInline,
} from "@/lib/expense-document-storage";
import type { UploadedFile } from "@/lib/uploaded-file";

// Business rule: a cash collection/withdrawal needs 1–3 supporting documents.
export const MIN_CASH_OPERATION_DOCUMENTS = 1;
export const MAX_CASH_OPERATION_DOCUMENTS = 3;

const ALLOWED_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
const KEY_PREFIX = "cash-docs";
export const CASH_STORAGE_KEY_RE = /^cash-docs\/[a-f0-9]{64}\.(jpg|png|webp|pdf)$/;

export type StoredCashDocument = {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  originalFilename: string;
  safeFilename: string;
};

/** Validate a single uploaded file (declared MIME/size, then magic-byte signature)
 * and persist it under a fresh unguessable key. Returns a stored-doc descriptor or
 * a safe error code — never a stack trace. */
export async function validateAndStoreCashDocument(
  file: unknown,
): Promise<{ ok: true; doc: StoredCashDocument } | { ok: false; code: string }> {
  const declared = validateDeclaredDocument(file);
  if (!declared.ok) return declared;
  const f = file as UploadedFile;
  const buffer = Buffer.from(await f.arrayBuffer());
  const sig = validateSignature(buffer, f.type);
  if (!sig.ok) return sig;
  const ext = ALLOWED_EXT[f.type];
  if (!ext) return { ok: false, code: "MIME_UNSUPPORTED" };
  const storageKey = `${KEY_PREFIX}/${randomBytes(32).toString("hex")}.${ext}`;
  await getStorage().put(storageKey, buffer, f.type);
  return {
    ok: true,
    doc: { storageKey, mimeType: f.type, sizeBytes: buffer.length, sha256: sha256Hex(buffer), originalFilename: f.name, safeFilename: safeFilename(f.name) },
  };
}

/** Read a stored cash document by key, rejecting anything outside the safe pattern. */
export async function readCashDocument(storageKey: string): Promise<Buffer | null> {
  if (!CASH_STORAGE_KEY_RE.test(storageKey)) return null;
  return getStorage().get(storageKey);
}

export { canPreviewInline };
