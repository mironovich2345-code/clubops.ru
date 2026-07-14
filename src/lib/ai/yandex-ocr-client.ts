// Server-only Yandex Vision OCR client (recognizeText, model "page"). Sends the
// raw document bytes (base64) and returns the recognized text — NEVER logs the
// base64, the recognized text, the storage key or the API key. The caller (the
// analyzer) owns all diagnostics; this module stays pure/testable and only
// returns safe, structured results.
import {
  YANDEX_OCR_URL,
  YANDEX_OCR_ASYNC_URL,
  YANDEX_OCR_GET_RECOGNITION_URL,
  YANDEX_OPERATION_URL,
  YANDEX_OCR_POLL_INTERVAL_MS,
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

/** Auth + privacy headers shared by every Yandex OCR request. Never logged. */
function ocrHeaders(key: string, folder: string): Record<string, string> {
  return {
    Authorization: `Api-Key ${key}`,
    "x-folder-id": folder,
    // Privacy: ask Yandex not to retain the payload unless explicitly enabled.
    "x-data-logging-enabled": yandexDataLoggingEnabled() ? "true" : "false",
    "Content-Type": "application/json",
  };
}

/** Request body shared by the sync and async recognize endpoints. */
function ocrBody(content: Buffer, mimeType: YandexOcrMime): string {
  return JSON.stringify({
    mimeType,
    languageCodes: yandexOcrLanguageCodes(),
    model: yandexOcrModel(),
    content: content.toString("base64"),
  });
}

function classifyThrow(error: unknown): "timeout" | "network" {
  return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      headers: ocrHeaders(key, folder),
      body: ocrBody(params.content, params.mimeType),
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch (error) {
    const reason = classifyThrow(error);
    return { ok: false, reason, safeCode: reason, durationMs: Date.now() - start };
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

/**
 * Asynchronous OCR for multi-page (or unknown-page-count) PDFs. Yandex requires
 * the async flow for multi-page PDFs — the sync endpoint returns HTTP 400:
 *   1. POST recognizeTextAsync → an Operation { id }.
 *   2. Poll operations/{id} until done (bounded by timeoutMs).
 *   3. GET getRecognition?operationId=… → NDJSON pages, merged in page order.
 * Same key/folder + x-data-logging-enabled=false. The base64, the recognized text
 * and the response bodies are never logged. Errors are the same discriminated
 * union as the sync path so the analyzer maps them to a manual-mode message.
 */
export async function recognizeTextAsync(params: {
  content: Buffer;
  timeoutMs: number;
  pollIntervalMs?: number;
}): Promise<OcrResult> {
  const key = process.env.YANDEX_AI_API_KEY;
  const folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) return { ok: false, reason: "http", safeCode: "not_configured", durationMs: 0 };

  const start = Date.now();
  const headers = ocrHeaders(key, folder);
  // Each individual HTTP call is bounded so a single hung request cannot exceed
  // the overall deadline unnoticed.
  const perRequestTimeout = Math.min(params.timeoutMs, 30_000);
  const pollInterval = Math.max(params.pollIntervalMs ?? YANDEX_OCR_POLL_INTERVAL_MS, 1);
  const elapsed = () => Date.now() - start;

  // 1) Submit the document for async recognition.
  let submitRes: Response;
  try {
    submitRes = await fetch(YANDEX_OCR_ASYNC_URL, {
      method: "POST",
      headers,
      body: ocrBody(params.content, "PDF"),
      signal: AbortSignal.timeout(perRequestTimeout),
    });
  } catch (error) {
    const reason = classifyThrow(error);
    return { ok: false, reason, safeCode: reason, durationMs: elapsed() };
  }
  if (!submitRes.ok) {
    const reason = submitRes.status === 415 ? "unsupported_file" : "http";
    return { ok: false, reason, safeCode: `http_${submitRes.status}`, httpStatus: submitRes.status, durationMs: elapsed() };
  }
  let op: unknown;
  try {
    op = await submitRes.json();
  } catch {
    return { ok: false, reason: "parse", safeCode: "invalid_json", durationMs: elapsed() };
  }
  const operationId = typeof (op as { id?: unknown })?.id === "string" ? (op as { id: string }).id : null;
  if (!operationId) return { ok: false, reason: "parse", safeCode: "no_operation_id", durationMs: elapsed() };

  // 2) Poll the operation until it is done or the deadline passes.
  while (elapsed() < params.timeoutMs) {
    await sleep(pollInterval);
    let pollRes: Response;
    try {
      pollRes = await fetch(`${YANDEX_OPERATION_URL}/${encodeURIComponent(operationId)}`, {
        method: "GET",
        headers: { Authorization: `Api-Key ${key}` },
        signal: AbortSignal.timeout(perRequestTimeout),
      });
    } catch (error) {
      const reason = classifyThrow(error);
      return { ok: false, reason, safeCode: reason, durationMs: elapsed() };
    }
    if (!pollRes.ok) {
      return { ok: false, reason: "http", safeCode: `http_${pollRes.status}`, httpStatus: pollRes.status, durationMs: elapsed() };
    }
    let status: unknown;
    try {
      status = await pollRes.json();
    } catch {
      return { ok: false, reason: "parse", safeCode: "invalid_json", durationMs: elapsed() };
    }
    if ((status as { error?: unknown })?.error) {
      return { ok: false, reason: "http", safeCode: "operation_error", durationMs: elapsed() };
    }
    if ((status as { done?: unknown })?.done === true) {
      return await fetchAsyncResults(operationId, headers, perRequestTimeout, start);
    }
  }
  return { ok: false, reason: "timeout", safeCode: "poll_timeout", durationMs: elapsed() };
}

/** Fetch + merge the finished async recognition pages (NDJSON, page order). */
async function fetchAsyncResults(
  operationId: string,
  headers: Record<string, string>,
  perRequestTimeout: number,
  start: number,
): Promise<OcrResult> {
  const elapsed = () => Date.now() - start;
  let res: Response;
  try {
    res = await fetch(`${YANDEX_OCR_GET_RECOGNITION_URL}?operationId=${encodeURIComponent(operationId)}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(perRequestTimeout),
    });
  } catch (error) {
    const reason = classifyThrow(error);
    return { ok: false, reason, safeCode: reason, durationMs: elapsed() };
  }
  if (!res.ok) {
    return { ok: false, reason: "http", safeCode: `http_${res.status}`, httpStatus: res.status, durationMs: elapsed() };
  }
  let body: string;
  try {
    body = await res.text();
  } catch {
    return { ok: false, reason: "parse", safeCode: "read_failed", durationMs: elapsed() };
  }
  const text = parseOcrBody(body);
  if (text === null) return { ok: false, reason: "parse", safeCode: "invalid_json", durationMs: elapsed() };
  if (!text.trim()) return { ok: false, reason: "empty_text", safeCode: "empty_text", durationMs: elapsed() };
  return { ok: true, text: text.slice(0, YANDEX_OCR_MAX_TEXT), durationMs: elapsed() };
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
