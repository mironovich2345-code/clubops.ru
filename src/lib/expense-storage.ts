import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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

/** Returns an error message if the file is invalid, otherwise null. */
export function validateExpenseFile(file: File): string | null {
  if (!(file instanceof File) || file.size === 0) return "Файл пустой";
  if (file.size > MAX_EXPENSE_FILE_SIZE) return "Файл больше 10 МБ";
  if (!ALLOWED_MIME[file.type]) return "Поддерживаются только JPG, PNG, WEBP и PDF";
  return null;
}

export type StoredFile = {
  storageKey: string;
  fileName: string;
  mime: string;
  size: number;
  buffer: Buffer;
};

export async function storeExpenseFile(file: File): Promise<StoredFile> {
  const ext = ALLOWED_MIME[file.type];
  if (!ext) throw new Error("Unsupported file type");

  const buffer = Buffer.from(await file.arrayBuffer());
  const name = `${randomBytes(16).toString("hex")}.${ext}`;
  const storageKey = `expenses/${name}`;

  await mkdir(EXPENSE_DIR, { recursive: true });
  await writeFile(join(EXPENSE_DIR, name), buffer);

  return { storageKey, fileName: file.name, mime: file.type, size: file.size, buffer };
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
