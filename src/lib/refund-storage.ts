import { randomBytes } from "node:crypto";
import { isUploadedFile, type UploadedFile } from "@/lib/uploaded-file";
import { getStorage } from "@/lib/storage";

// Refund documents are addressed by relative storageKeys ("refunds/<hex>.ext"),
// kept in the DB as a JSON array (documentsJson), and persisted through the
// storage abstraction: local disk in dev (default) or S3-compatible object
// storage in production (STORAGE_PROVIDER=s3).
const KEY_PREFIX = "refunds";

export const MAX_REFUND_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file
export const MAX_REFUND_FILES = 10;

const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const STORAGE_KEY_RE = /^refunds\/[a-f0-9]{32}\.(jpg|png|webp|pdf)$/;

export function validateRefundFile(file: UploadedFile): string | null {
  if (!isUploadedFile(file) || file.size === 0) return "Файл пустой";
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

export async function storeRefundFile(file: UploadedFile): Promise<StoredRefundFile> {
  const ext = ALLOWED_MIME[file.type];
  if (!ext) throw new Error("Unsupported file type");

  const buffer = Buffer.from(await file.arrayBuffer());
  const storageKey = `${KEY_PREFIX}/${randomBytes(16).toString("hex")}.${ext}`;
  await getStorage().put(storageKey, buffer, file.type);

  return { storageKey, fileName: file.name, mime: file.type, size: file.size, buffer };
}

export async function readRefundFile(storageKey: string): Promise<Buffer | null> {
  if (!STORAGE_KEY_RE.test(storageKey)) return null;
  return getStorage().get(storageKey);
}
