import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Uploaded invoice documents live on local disk under <cwd>/uploads/invoices.
// Only metadata + a relative storageKey are kept in the DB; absolute paths are
// never exposed to the client. (Note: on Railway the FS is ephemeral.)
const UPLOAD_ROOT = join(process.cwd(), "uploads");
const INVOICE_DIR = join(UPLOAD_ROOT, "invoices");

export const MAX_INVOICE_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const STORAGE_KEY_RE = /^invoices\/[a-f0-9]{32}\.(jpg|png|webp|pdf)$/;

/** Returns an error message if the file is invalid, otherwise null. */
export function validateInvoiceFile(file: File): string | null {
  if (!(file instanceof File) || file.size === 0) return "Выберите файл";
  if (file.size > MAX_INVOICE_FILE_SIZE) return "Файл больше 10 МБ";
  if (!ALLOWED_MIME[file.type]) {
    return "Поддерживаются только JPG, PNG, WEBP и PDF";
  }
  return null;
}

export type StoredFile = {
  storageKey: string;
  fileName: string;
  mime: string;
  size: number;
  buffer: Buffer;
};

export async function storeInvoiceFile(file: File): Promise<StoredFile> {
  const ext = ALLOWED_MIME[file.type];
  if (!ext) throw new Error("Unsupported file type");

  const buffer = Buffer.from(await file.arrayBuffer());
  const name = `${randomBytes(16).toString("hex")}.${ext}`;
  const storageKey = `invoices/${name}`;

  await mkdir(INVOICE_DIR, { recursive: true });
  await writeFile(join(INVOICE_DIR, name), buffer);

  return {
    storageKey,
    fileName: file.name,
    mime: file.type,
    size: file.size,
    buffer,
  };
}

/**
 * Persists an already-read buffer to disk. Separated from reading the upload so
 * the caller can analyze the in-memory buffer even if the disk write fails (e.g.
 * read-only/ephemeral filesystem on the host). Returns the stored metadata.
 */
export async function persistInvoiceFile(
  buffer: Buffer,
  mime: string,
  originalName: string,
): Promise<{ storageKey: string; fileName: string; mime: string; size: number }> {
  const ext = ALLOWED_MIME[mime];
  if (!ext) throw new Error("Unsupported file type");
  const name = `${randomBytes(16).toString("hex")}.${ext}`;
  const storageKey = `invoices/${name}`;
  await mkdir(INVOICE_DIR, { recursive: true });
  await writeFile(join(INVOICE_DIR, name), buffer);
  return { storageKey, fileName: originalName, mime, size: buffer.length };
}

/** Reads a stored file by its storageKey. Rejects anything outside the safe pattern. */
export async function readInvoiceFile(storageKey: string): Promise<Buffer | null> {
  if (!STORAGE_KEY_RE.test(storageKey)) return null;
  const relative = storageKey.slice("invoices/".length);
  try {
    return await readFile(join(INVOICE_DIR, relative));
  } catch {
    return null;
  }
}
