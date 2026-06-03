import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Uploaded refund documents live on local disk under <cwd>/uploads/refunds.
// Only metadata + relative storageKeys are kept in the DB (documentsJson);
// absolute paths are never exposed. (Note: on Railway the FS is ephemeral.)
const UPLOAD_ROOT = join(process.cwd(), "uploads");
const REFUND_DIR = join(UPLOAD_ROOT, "refunds");

export const MAX_REFUND_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file
export const MAX_REFUND_FILES = 10;

const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const STORAGE_KEY_RE = /^refunds\/[a-f0-9]{32}\.(jpg|png|webp|pdf)$/;

export function validateRefundFile(file: File): string | null {
  if (!(file instanceof File) || file.size === 0) return "Файл пустой";
  if (file.size > MAX_REFUND_FILE_SIZE) return "Файл больше 10 МБ";
  if (!ALLOWED_MIME[file.type]) return "Поддерживаются только JPG, PNG, WEBP и PDF";
  return null;
}

export type StoredRefundFile = {
  storageKey: string;
  fileName: string;
  mime: string;
  size: number;
  buffer: Buffer;
};

export async function storeRefundFile(file: File): Promise<StoredRefundFile> {
  const ext = ALLOWED_MIME[file.type];
  if (!ext) throw new Error("Unsupported file type");

  const buffer = Buffer.from(await file.arrayBuffer());
  const name = `${randomBytes(16).toString("hex")}.${ext}`;
  const storageKey = `refunds/${name}`;

  await mkdir(REFUND_DIR, { recursive: true });
  await writeFile(join(REFUND_DIR, name), buffer);

  return { storageKey, fileName: file.name, mime: file.type, size: file.size, buffer };
}

export async function readRefundFile(storageKey: string): Promise<Buffer | null> {
  if (!STORAGE_KEY_RE.test(storageKey)) return null;
  const relative = storageKey.slice("refunds/".length);
  try {
    return await readFile(join(REFUND_DIR, relative));
  } catch {
    return null;
  }
}
