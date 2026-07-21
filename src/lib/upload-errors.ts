// Safe, user-facing error categories for the document upload/recognition flow.
// Pure module (no server deps) so both server actions and client components can
// use it. Messages are deliberately generic — no stack traces, no secrets.

export type UploadErrorCode =
  | "FILE_INVALID"
  | "FILE_TOO_LARGE"
  | "FILE_READ_FAILED"
  | "STORAGE_FAILED"
  | "AI_PROVIDER_NOT_CONFIGURED"
  | "AI_PROVIDER_FAILED"
  | "AI_INVALID_RESPONSE"
  | "ACCESS_DENIED"
  | "CLUB_REQUIRED"
  | "RATE_LIMITED"
  | "UNKNOWN_ERROR";

export const UPLOAD_ERROR_MESSAGES: Record<UploadErrorCode, string> = {
  CLUB_REQUIRED: "Выберите клуб",
  RATE_LIMITED: "Слишком много попыток. Повторите позже.",
  FILE_INVALID: "Файл не поддерживается",
  FILE_TOO_LARGE: "Файл слишком большой",
  FILE_READ_FAILED: "Не удалось прочитать файл",
  STORAGE_FAILED: "Файл принят, но сохранить оригинал не удалось",
  AI_PROVIDER_NOT_CONFIGURED: "ИИ не настроен",
  AI_PROVIDER_FAILED: "ИИ не смог обработать документ",
  AI_INVALID_RESPONSE: "ИИ вернул некорректный ответ",
  ACCESS_DENIED: "Нет доступа к выбранному клубу",
  UNKNOWN_ERROR: "Неизвестная ошибка обработки",
};

export function uploadErrorMessage(code: UploadErrorCode): string {
  return UPLOAD_ERROR_MESSAGES[code] ?? UPLOAD_ERROR_MESSAGES.UNKNOWN_ERROR;
}

// Stages of the upload/recognition pipeline, used for sanitized diagnostics.
export type UploadStage =
  | "validate"
  | "preview"
  | "upload"
  | "analyze"
  | "normalize"
  | "render-response";

export type UploadFailureInfo = {
  code: UploadErrorCode;
  message: string;
  userId: string | null;
  companyId: string | null;
  clubId: string | null;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
  /** Correlates the log line with the failing request. */
  requestId?: string;
  /** Pipeline stage where the failure occurred. */
  stage?: UploadStage;
};

/** Short, collision-resistant id for correlating a failed upload in the logs. */
export function newRequestId(): string {
  return `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Server-side sanitized log line for a failed upload. Deliberately logs only
 * non-sensitive metadata — never file contents, AI prompt/document text, tokens,
 * secrets, storage credentials or full stack traces. `message` is a short, host
 * code/error string already stripped of payloads by callers.
 */
export function logUploadFailure(scope: string, info: UploadFailureInfo): void {
  console.error(`[upload:${scope}] ${info.code}`, {
    requestId: info.requestId ?? null,
    timestamp: new Date().toISOString(),
    stage: info.stage ?? null,
    message: info.message,
    userId: info.userId,
    companyId: info.companyId,
    clubId: info.clubId,
    fileMime: info.fileMime,
    fileSize: info.fileSize,
    env: process.env.NODE_ENV ?? "unknown",
  });
}
