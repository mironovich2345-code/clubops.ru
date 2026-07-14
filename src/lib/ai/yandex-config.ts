// Server-only Yandex Cloud AI (Vision OCR + YandexGPT) configuration. Values are
// read ONLY from the environment; the API key is never returned, logged or built
// into the client bundle. Selected via AI_PROVIDER=yandex (see selectedAiProvider
// in openai-client.ts). Endpoints per Yandex Cloud AI docs.

export const YANDEX_OCR_URL = "https://ai.api.cloud.yandex.net/ocr/v1/recognizeText";
export const YANDEX_GPT_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";

// Max OCR characters forwarded to YandexGPT (bounded so a huge scan cannot blow
// the token budget). Content is never logged.
export const YANDEX_OCR_MAX_TEXT = 30_000;

/** Both the API key and folder id are required for a real call. */
export function yandexConfigured(): boolean {
  return Boolean(process.env.YANDEX_AI_API_KEY && process.env.YANDEX_FOLDER_ID);
}

export function yandexFolderId(): string {
  return process.env.YANDEX_FOLDER_ID ?? "";
}

export function yandexOcrModel(): string {
  return process.env.YANDEX_OCR_MODEL || "page";
}

/**
 * Full YandexGPT model URI. If YANDEX_GPT_MODEL is a bare name ("yandexgpt-5-lite")
 * it is expanded to gpt://<folderId>/<name>; a value that already starts with
 * "gpt://" is used verbatim.
 */
export function yandexGptModelUri(folderId: string): string {
  const m = process.env.YANDEX_GPT_MODEL || "yandexgpt-5-lite";
  return m.startsWith("gpt://") ? m : `gpt://${folderId}/${m}`;
}

export function yandexAiTimeoutMs(): number {
  const n = Number(process.env.YANDEX_AI_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5_000 && n <= 120_000 ? n : 60_000;
}

/** Whether Yandex may retain request payloads. Default OFF (privacy). */
export function yandexDataLoggingEnabled(): boolean {
  return process.env.YANDEX_DATA_LOGGING_ENABLED === "true";
}

export function yandexOcrLanguageCodes(): string[] {
  const v = process.env.YANDEX_OCR_LANGUAGE_CODES?.trim();
  if (!v) return ["*"];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export type YandexOcrMime = "JPEG" | "PNG" | "PDF";

/**
 * Map a MAGIC-BYTE-detected real MIME to a Yandex OCR mimeType. Returns null for
 * formats Yandex OCR does not accept (e.g. WEBP) or unknown types — the caller
 * then routes to manual entry. The client-declared type is never trusted.
 */
export function toYandexOcrMime(realMime: string | null): YandexOcrMime | null {
  switch (realMime) {
    case "image/jpeg":
      return "JPEG";
    case "image/png":
      return "PNG";
    case "application/pdf":
      return "PDF";
    default:
      return null;
  }
}
