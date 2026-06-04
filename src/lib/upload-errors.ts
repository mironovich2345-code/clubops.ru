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
  | "UNKNOWN_ERROR";

export const UPLOAD_ERROR_MESSAGES: Record<UploadErrorCode, string> = {
  CLUB_REQUIRED: "Выберите клуб",
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

export type UploadFailureInfo = {
  code: UploadErrorCode;
  message: string;
  userId: string | null;
  companyId: string | null;
  clubId: string | null;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
};

/** Server-side sanitized log line for a failed upload (no API key, no file content). */
export function logUploadFailure(scope: string, info: UploadFailureInfo): void {
  console.error(`[upload:${scope}] ${info.code}`, {
    message: info.message,
    userId: info.userId,
    companyId: info.companyId,
    clubId: info.clubId,
    fileName: info.fileName,
    fileMime: info.fileMime,
    fileSize: info.fileSize,
  });
}
