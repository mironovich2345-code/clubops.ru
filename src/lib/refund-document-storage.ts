// Storage + validation for v2 refund slot documents. Mirrors the expense-
// document storage: opaque server-generated keys, magic-byte signature check,
// SHA-256, private storage via getStorage(). Server-only.
import { createHash, randomBytes } from "node:crypto";
import { getStorage } from "@/lib/storage";
import type { UploadedFile } from "@/lib/uploaded-file";
import { isUploadedFile } from "@/lib/uploaded-file";

export const MAX_REFUND_DOC_SIZE = 10 * 1024 * 1024; // 10 MB / file
export const MAX_REFUND_DOC_AGGREGATE = 40 * 1024 * 1024; // 40 MB / refund set

const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
export const REFUND_ALLOWED_MIME_TYPES = Object.keys(ALLOWED_MIME);

const KEY_PREFIX = "refund-docs";
const STORAGE_KEY_RE = /^refund-docs\/[a-f0-9]{64}\.(jpg|png|webp|pdf)$/;

export type DocValidation = { ok: true } | { ok: false; code: string };

function isHeicByName(file: UploadedFile): boolean {
  return file.type === "image/heic" || file.type === "image/heif" || /\.(heic|heif)$/i.test(file.name);
}

/** Declared-MIME + size + non-empty checks (before reading bytes). */
export function validateDeclaredRefundDoc(file: unknown): DocValidation {
  if (!isUploadedFile(file) || file.size === 0) return { ok: false, code: "FILE_EMPTY" };
  if (isHeicByName(file)) return { ok: false, code: "MIME_UNSUPPORTED" };
  if (!ALLOWED_MIME[file.type]) return { ok: false, code: "MIME_UNSUPPORTED" };
  if (file.size > MAX_REFUND_DOC_SIZE) return { ok: false, code: "FILE_TOO_LARGE" };
  return { ok: true };
}

/** Magic-byte signature → canonical MIME, or null. Detects HEIC/HEIF by ISO-BMFF brand
 * so a HEIC that slipped past the name/type check gets a precise error, not FILE_INVALID. */
export function detectSignatureMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("latin1").toLowerCase();
    if (["heic", "heix", "heif", "mif1", "hevc", "hevx"].includes(brand)) return "image/heic";
  }
  return null;
}

/** Validate the file SIGNATURE against the declared MIME (anti-spoof). */
export function validateRefundSignature(buf: Buffer, declaredMime: string): DocValidation {
  const detected = detectSignatureMime(buf);
  if (detected === "image/heic") return { ok: false, code: "HEIC_UNSUPPORTED" };
  if (!detected) return { ok: false, code: "FILE_INVALID" };
  if (detected !== declaredMime) return { ok: false, code: "MIME_MISMATCH" };
  return { ok: true };
}

/** Classify a storage-layer failure into a precise code (config/unavailable vs write). */
export function classifyStorageError(e: unknown): "STORAGE_UNAVAILABLE" | "STORAGE_WRITE_FAILED" {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not configured|missing|ENOTFOUND|ECONNREFUSED|AccessDenied|credentials|endpoint/i.test(msg)) return "STORAGE_UNAVAILABLE";
  return "STORAGE_WRITE_FAILED";
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Sanitize a user filename for display (no path, no control chars). */
export function safeFilename(original: string): string {
  const base = (original || "document").replace(/^.*[\\/]/, "").replace(/[ -<>:"|?*]/g, "_").trim();
  return (base || "document").slice(0, 180);
}

function newKey(ext: string): string {
  return `${KEY_PREFIX}/${randomBytes(32).toString("hex")}.${ext}`;
}

export type StoredRefundDocument = { storageKey: string; mime: string; sizeBytes: number; sha256: string };

/** Persist a validated buffer under a fresh unguessable key. */
export async function storeRefundDocument(buffer: Buffer, mime: string): Promise<StoredRefundDocument> {
  const ext = ALLOWED_MIME[mime];
  if (!ext) throw new Error("Unsupported file type");
  const storageKey = newKey(ext);
  await getStorage().put(storageKey, buffer, mime);
  return { storageKey, mime, sizeBytes: buffer.length, sha256: sha256Hex(buffer) };
}

/** Read a stored refund document by key. Rejects anything off the safe pattern. */
export async function readRefundDocument(storageKey: string): Promise<Buffer | null> {
  if (!STORAGE_KEY_RE.test(storageKey)) return null;
  return getStorage().get(storageKey);
}

export function canPreviewInline(mime: string): boolean {
  return mime === "image/jpeg" || mime === "image/png" || mime === "application/pdf";
}

// Sanitized Russian error messages (no internals). Shared with the actions.
export const REFUND_DOC_ERRORS: Record<string, string> = {
  FILE_EMPTY: "Файл пустой.",
  MIME_UNSUPPORTED: "Формат не поддерживается. Разрешены JPG, PNG, WEBP, PDF.",
  FILE_TOO_LARGE: "Файл слишком большой (максимум 10 МБ).",
  AGGREGATE_EXCEEDED: "Превышен общий размер комплекта (максимум 40 МБ).",
  MIME_MISMATCH: "Содержимое файла не соответствует его типу.",
  FILE_INVALID: "Файл повреждён или не является изображением/PDF.",
  SLOT_INVALID: "Этот документ не относится к выбранному типу возврата.",
  SLOT_CONFLICT: "В этот слот уже загружается файл. Обновите страницу.",
  STORAGE_FAILED: "Не удалось сохранить файл. Повторите попытку позже.",
  STORAGE_UNAVAILABLE: "Хранилище файлов временно недоступно. Повторите позже или обратитесь в поддержку.",
  STORAGE_WRITE_FAILED: "Не удалось записать файл в хранилище. Повторите попытку.",
  DATABASE_WRITE_FAILED: "Не удалось сохранить запись о документе. Повторите попытку.",
  HEIC_UNSUPPORTED: "Формат HEIC (фото с iPhone) не поддерживается. Сохраните файл как JPG или PDF и загрузите снова.",
  DUPLICATE_FILE: "Этот файл уже загружен в этом возврате.",
  REQUEST_TOO_LARGE: "Файл слишком большой для загрузки (максимум 10 МБ).",
  UPLOAD_TIMEOUT: "Загрузка заняла слишком много времени. Проверьте соединение и повторите.",
  NETWORK_ERROR: "Ошибка сети при загрузке. Проверьте соединение и повторите.",
  ACCESS_DENIED: "Нет доступа к этому возврату.",
  NOT_EDITABLE: "Возврат больше нельзя редактировать.",
  NOT_FOUND: "Документ не найден.",
  REASON_REQUIRED: "Укажите причину удаления.",
  UNKNOWN_UPLOAD_ERROR: "Не удалось загрузить документ. Повторите попытку.",
  UNKNOWN: "Не удалось обработать документ.",
};
export function refundDocError(code: string): string {
  return REFUND_DOC_ERRORS[code] ?? REFUND_DOC_ERRORS.UNKNOWN;
}
