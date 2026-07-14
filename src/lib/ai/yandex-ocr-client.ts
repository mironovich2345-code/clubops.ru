// Server-only Yandex Vision OCR client (recognizeText, model "page"). Sends the
// raw document bytes (base64) and returns the recognized text — NEVER logs the
// base64, the recognized text, the storage key or the API key. The caller (the
// analyzer) owns all diagnostics; this module stays pure/testable and only
// returns safe, structured results.
import {
  YANDEX_OCR_URL,
  YANDEX_OCR_MAX_TEXT,
  yandexOcrModel,
  yandexOcrLanguageCodes,
  yandexDataLoggingEnabled,
  type YandexOcrMime,
} from "@/lib/ai/yandex-config";

export type OcrResult =
  | { ok: true; text: string; durationMs: number }
  | {
      ok: false;
      reason: "http" | "timeout" | "network" | "parse" | "unsupported_file" | "empty_text";
      safeCode: string;
      httpStatus?: number;
      durationMs: number;
    };

/**
 * Recognize text from a document via Yandex Vision OCR. `content` is the raw,
 * magic-byte-validated file buffer; `mimeType` is the OCR-supported type mapped
 * from the real MIME (never the client's declared type). Errors are returned as a
 * discriminated union — the request body / response body are never surfaced.
 */
export async function recognizeText(params: {
  content: Buffer;
  mimeType: YandexOcrMime;
  timeoutMs: number;
}): Promise<OcrResult> {
  const key = process.env.YANDEX_AI_API_KEY;
  const folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) return { ok: false, reason: "http", safeCode: "not_configured", durationMs: 0 };

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(YANDEX_OCR_URL, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${key}`,
        "x-folder-id": folder,
        // Privacy: ask Yandex not to retain the payload unless explicitly enabled.
        "x-data-logging-enabled": yandexDataLoggingEnabled() ? "true" : "false",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mimeType: params.mimeType,
        languageCodes: yandexOcrLanguageCodes(),
        model: yandexOcrModel(),
        content: params.content.toString("base64"),
      }),
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      reason: timedOut ? "timeout" : "network",
      safeCode: timedOut ? "timeout" : "network",
      durationMs: Date.now() - start,
    };
  }

  const durationMs = Date.now() - start;
  if (!res.ok) {
    // Never read/keep the body (it may echo the content). Only the status.
    const reason = res.status === 415 ? "unsupported_file" : "http";
    return { ok: false, reason, safeCode: `http_${res.status}`, httpStatus: res.status, durationMs };
  }

  // The sync recognizeText endpoint may return a single JSON object or, for
  // multi-page PDFs, newline-delimited JSON (one object per page). Handle both.
  let body: string;
  try {
    body = await res.text();
  } catch {
    return { ok: false, reason: "parse", safeCode: "read_failed", durationMs };
  }
  const text = parseOcrBody(body);
  if (text === null) return { ok: false, reason: "parse", safeCode: "invalid_json", durationMs };
  if (!text.trim()) return { ok: false, reason: "empty_text", safeCode: "empty_text", durationMs };

  return { ok: true, text: text.slice(0, YANDEX_OCR_MAX_TEXT), durationMs };
}

/** Parse a single-object OR NDJSON OCR response body into merged text. Returns
 * null only when nothing could be parsed as JSON (a real parse failure). */
export function parseOcrBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return "";
  let objects: unknown[] = [];
  try {
    objects = [JSON.parse(trimmed)];
  } catch {
    // Try NDJSON (one JSON object per line).
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let anyParsed = false;
    for (const line of lines) {
      try {
        objects.push(JSON.parse(line));
        anyParsed = true;
      } catch {
        /* skip a bad line */
      }
    }
    if (!anyParsed) return null;
  }

  const parts: string[] = [];
  for (const obj of objects) {
    const ta = (obj as { result?: { textAnnotation?: unknown } })?.result?.textAnnotation;
    const t = assembleAnnotationText(ta);
    if (t) parts.push(t);
  }
  return parts.join("\n");
}

/** Prefer the annotation's fullText; otherwise assemble blocks → lines →
 * (line.text | words). Preserves line order. */
function assembleAnnotationText(ta: unknown): string {
  const a = ta as
    | { fullText?: unknown; blocks?: Array<{ lines?: Array<{ text?: unknown; words?: Array<{ text?: unknown }> }> }> }
    | undefined;
  if (typeof a?.fullText === "string" && a.fullText.trim()) return a.fullText.trim();
  const lines: string[] = [];
  for (const block of a?.blocks ?? []) {
    for (const line of block?.lines ?? []) {
      if (typeof line?.text === "string" && line.text.trim()) {
        lines.push(line.text.trim());
        continue;
      }
      const words = (line?.words ?? [])
        .map((w) => (typeof w?.text === "string" ? w.text : ""))
        .filter(Boolean);
      if (words.length) lines.push(words.join(" "));
    }
  }
  return lines.join("\n");
}
