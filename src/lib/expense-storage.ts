import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { UploadErrorCode } from "@/lib/upload-errors";
import { isUploadedFile, type UploadedFile } from "@/lib/uploaded-file";

// Uploaded expense documents live on local disk under <cwd>/uploads/expenses.
// Only metadata + a relative storageKey are kept in the DB; absolute paths are
// never exposed to the client. (Note: on Railway the FS is ephemeral.)
const UPLOAD_ROOT = join(process.cwd(), "uploads");
const EXPENSE_DIR = join(UPLOAD_ROOT, "expenses");

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

export async function storeExpenseFile(file: UploadedFile): Promise<StoredFile> {
  const ext = ALLOWED_MIME[file.type];
  if (!ext) throw new Error("Unsupported file type");

  const buffer = Buffer.from(await file.arrayBuffer());
  const name = `${randomBytes(16).toString("hex")}.${ext}`;
  const storageKey = `expenses/${name}`;

  await mkdir(EXPENSE_DIR, { recursive: true });
  await writeFile(join(EXPENSE_DIR, name), buffer);

  return { storageKey, fileName: file.name, mime: file.type, size: file.size, buffer };
}

/**
 * Persists an already-read buffer to disk, separated from reading the upload so
 * the caller can analyze the in-memory buffer even if the disk write fails.
 */
export async function persistExpenseFile(
  buffer: Buffer,
  mime: string,
  originalName: string,
): Promise<{ storageKey: string; fileName: string; mime: string; size: number }> {
  const ext = ALLOWED_MIME[mime];
  if (!ext) throw new Error("Unsupported file type");
  const name = `${randomBytes(16).toString("hex")}.${ext}`;
  const storageKey = `expenses/${name}`;
  await mkdir(EXPENSE_DIR, { recursive: true });
  await writeFile(join(EXPENSE_DIR, name), buffer);
  return { storageKey, fileName: originalName, mime, size: buffer.length };
}

/** Reads a stored file by its storageKey. Rejects anything outside the safe pattern. */
export async function readExpenseFile(storageKey: string): Promise<Buffer | null> {
  if (!STORAGE_KEY_RE.test(storageKey)) return null;
  const relative = storageKey.slice("expenses/".length);
  try {
    return await readFile(join(EXPENSE_DIR, relative));
  } catch {
    return null;
  }
}
