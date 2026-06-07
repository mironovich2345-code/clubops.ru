import { randomBytes } from "node:crypto";
import { isUploadedFile, type UploadedFile } from "@/lib/uploaded-file";
import { getStorage } from "@/lib/storage";

// Sales-report documents (screenshots, cash/acquiring reports, Kraft exports,
// manual tables). Stored via the storage abstraction (local disk in dev, S3 in
// prod) under "sales-reports/<hex>.<ext>"; metadata lives in SalesReportDocument.
const KEY_PREFIX = "sales-reports";

export const MAX_REPORT_FILE_SIZE = 15 * 1024 * 1024; // 15 MB per file
export const MAX_REPORT_FILES = 20;

// Photos / images / PDF + simple spreadsheets (xls / xlsx / csv).
const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "application/csv": "csv",
};

// Some browsers send CSV with an empty or generic MIME; fall back on extension.
const EXT_FALLBACK: Record<string, string> = {
  jpg: "jpg",
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  heic: "heic",
  pdf: "pdf",
  xls: "xls",
  xlsx: "xlsx",
  csv: "csv",
};

const STORAGE_KEY_RE = /^sales-reports\/[a-f0-9]{32}\.(jpg|png|webp|heic|pdf|xls|xlsx|csv)$/;

function extFor(file: UploadedFile): string | null {
  const byMime = ALLOWED_MIME[file.type];
  if (byMime) return byMime;
  const m = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? EXT_FALLBACK[m[1]] ?? null : null;
}

export function validateReportFile(file: UploadedFile): string | null {
  if (!isUploadedFile(file) || file.size === 0) return "Файл пустой";
  if (file.size > MAX_REPORT_FILE_SIZE) return "Файл больше 15 МБ";
  if (!extFor(file)) return "Поддерживаются JPG, PNG, WEBP, PDF, XLS, XLSX, CSV";
  return null;
}

export type StoredReportFile = {
  storageKey: string;
  fileName: string;
  mime: string;
  size: number;
};

export async function storeReportFile(file: UploadedFile): Promise<StoredReportFile> {
  const ext = extFor(file);
  if (!ext) throw new Error("Unsupported file type");
  const buffer = Buffer.from(await file.arrayBuffer());
  const storageKey = `${KEY_PREFIX}/${randomBytes(16).toString("hex")}.${ext}`;
  await getStorage().put(storageKey, buffer, file.type || "application/octet-stream");
  return { storageKey, fileName: file.name, mime: file.type || "application/octet-stream", size: file.size };
}

export async function readReportFile(storageKey: string): Promise<Buffer | null> {
  if (!STORAGE_KEY_RE.test(storageKey)) return null;
  return getStorage().get(storageKey);
}
