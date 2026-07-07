// Sanitized, user-facing Russian messages for expense-document operations.
// Pure module (no server deps) so client + server share it. No storage/provider
// internals, no secrets.
export type DocErrorCode =
  | "FILE_EMPTY"
  | "MIME_UNSUPPORTED"
  | "HEIC_UNSUPPORTED"
  | "FILE_TOO_LARGE"
  | "MIME_MISMATCH"
  | "FILE_INVALID"
  | "TOO_MANY"
  | "TOO_MANY_SIMPLIFIED"
  | "AGGREGATE_EXCEEDED"
  | "DUPLICATE"
  | "STORAGE_FAILED"
  | "ACCESS_DENIED"
  | "NOT_EDITABLE"
  | "MONTH_CLOSED"
  | "MIN_DOCUMENTS"
  | "ALREADY_REMOVED"
  | "REASON_REQUIRED"
  | "NOT_FOUND"
  | "UNKNOWN";

export const DOC_ERROR_MESSAGES: Record<DocErrorCode, string> = {
  FILE_EMPTY: "Файл пустой.",
  MIME_UNSUPPORTED: "Формат не поддерживается. Разрешены JPEG, PNG, WEBP, PDF.",
  HEIC_UNSUPPORTED: "Формат HEIC не поддерживается. Сохраните фото как JPEG и загрузите снова.",
  FILE_TOO_LARGE: "Файл слишком большой (максимум 10 МБ).",
  MIME_MISMATCH: "Содержимое файла не соответствует его типу.",
  FILE_INVALID: "Файл повреждён или не является изображением/PDF.",
  TOO_MANY: "Слишком много документов (максимум 10 на расход).",
  TOO_MANY_SIMPLIFIED: "Можно прикрепить не более 3 файлов.",
  AGGREGATE_EXCEEDED: "Превышен общий размер документов (максимум 40 МБ на расход).",
  DUPLICATE: "Такой документ уже прикреплён к этому расходу.",
  STORAGE_FAILED: "Не удалось сохранить файл. Повторите попытку позже.",
  ACCESS_DENIED: "Нет доступа к этому расходу.",
  NOT_EDITABLE: "Документы этого расхода нельзя изменять на текущем этапе.",
  MONTH_CLOSED: "Месяц закрыт — изменение документов недоступно.",
  MIN_DOCUMENTS: "Нельзя удалить последний документ на этом этапе.",
  ALREADY_REMOVED: "Документ уже удалён.",
  REASON_REQUIRED: "Укажите причину удаления.",
  NOT_FOUND: "Документ не найден.",
  UNKNOWN: "Не удалось обработать документ.",
};

export function docErrorMessage(code: DocErrorCode): string {
  return DOC_ERROR_MESSAGES[code] ?? DOC_ERROR_MESSAGES.UNKNOWN;
}
