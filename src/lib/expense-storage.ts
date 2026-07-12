import { randomBytes } from "node:crypto";
import type { UploadErrorCode } from "@/lib/upload-errors";
import { isUploadedFile, type UploadedFile } from "@/lib/uploaded-file";
import { getStorage } from "@/lib/storage";
import { sniffDocumentSignature } from "@/lib/document-access";

// Expense documents are addressed by a relative storageKey ("expenses/<hex>.ext")
// and persisted through the storage abstraction: local disk in dev (default) or
// S3-compatible object storage in production (STORAGE_PROVIDER=s3).
const KEY_PREFIX = "expenses";

export const MAX_EXPENSE_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const STORAGE_KEY_RE = /^expenses\/[a-f0-9]{32}\.(jpg|png|webp|pdf)$/;

/** Returns an error code if the file is invalid, otherwise null. */
export function validateExpenseFile(file: UploadedFile): UploadErrorCode | null {
  if (!isUploadedFile(file) || file.size === 0) return "FILE_INVALID";
  if (file.size > MAX_EXPENSE_FILE_SIZE) return "FILE_TOO_LARGE";
  if (!ALLOWED_MIME[file.type]) return "FILE_INVALID";
  return null;
}

export type StoredFile = {
  storageKey: string;
  fileName: string;
  mime: string;
  size: number;
  buffer: Buffer;
};

function newKey(ext: string): string {
  return `${KEY_PREFIX}/${randomBytes(16).toString("hex")}.${ext}`;
}

export async function storeExpenseFile(file: UploadedFile): Promise<StoredFile> {
  const ext = ALLOWED_MIME[file.type];
  if (!ext) throw new Error("Unsupported file type");

  const buffer = Buffer.from(await file.arrayBuffer());
  const storageKey = newKey(ext);
  await getStorage().put(storageKey, buffer, file.type);

  return { storageKey, fileName: file.name, mime: file.type, size: file.size, buffer };
}

/**
 * Persists an already-read buffer, separated from reading the upload so the
 * caller can analyze the in-memory buffer even if the write fails.
 */
export async function persistExpenseFile(
  buffer: Buffer,
  mime: string,
  originalName: string,
): Promise<{ storageKey: string; fileName: string; mime: string; size: number }> {
  const ext = ALLOWED_MIME[mime];
  if (!ext) throw new Error("Unsupported file type");
  // Defense-in-depth: reject non-image/PDF bytes (disguised HTML/SVG/script).
  if (!sniffDocumentSignature(buffer)) throw new Error("File content does not match an allowed image/PDF type");
  const storageKey = newKey(ext);
  await getStorage().put(storageKey, buffer, mime);
  return { storageKey, fileName: originalName, mime, size: buffer.length };
}

/** Reads a stored file by its storageKey. Rejects anything outside the safe pattern. */
export async function readExpenseFile(storageKey: string): Promise<Buffer | null> {
  if (!STORAGE_KEY_RE.test(storageKey)) return null;
  return getStorage().get(storageKey);
}
