// Server-only YandexGPT client (Foundation Models text completion). Turns OCR
// text into a structured JSON object. Prompt-agnostic: the caller supplies the
// system prompt (kept identical to the existing invoice schema so mapInvoiceJson
// can be reused). NEVER logs the prompt, the OCR text, the response or the API
// key — returns only safe, structured results.
import {
  YANDEX_GPT_URL,
  yandexGptModelUri,
  yandexDataLoggingEnabled,
} from "@/lib/ai/yandex-config";

export type GptResult =
  | { ok: true; json: Record<string, unknown>; durationMs: number }
  | { ok: false; reason: "http" | "timeout" | "network" | "parse"; safeCode: string; httpStatus?: number; durationMs: number };

/**
 * Ask YandexGPT to extract structured invoice fields from OCR text. Uses a strict
 * "return only JSON" prompt (the caller's system message) and parses the answer
 * defensively (markdown fences / surrounding prose are stripped). The document
 * text is passed as untrusted data — the system prompt forbids obeying it.
 */
export async function extractInvoiceFields(params: {
  system: string;
  user: string;
  timeoutMs: number;
}): Promise<GptResult> {
  const key = process.env.YANDEX_AI_API_KEY;
  const folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) return { ok: false, reason: "http", safeCode: "not_configured", durationMs: 0 };

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(YANDEX_GPT_URL, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${key}`,
        "x-folder-id": folder,
        "x-data-logging-enabled": yandexDataLoggingEnabled() ? "true" : "false",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        modelUri: yandexGptModelUri(folder),
        completionOptions: { stream: false, temperature: 0, maxTokens: "2000" },
        messages: [
          { role: "system", text: params.system },
          { role: "user", text: params.user },
        ],
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
    return { ok: false, reason: "http", safeCode: `http_${res.status}`, httpStatus: res.status, durationMs };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: "parse", safeCode: "invalid_json", durationMs };
  }

  const answer = (data as { result?: { alternatives?: Array<{ message?: { text?: unknown } }> } })
    ?.result?.alternatives?.[0]?.message?.text;
  const json = parseModelJson(typeof answer === "string" ? answer : "");
  if (!json) return { ok: false, reason: "parse", safeCode: "non_json_answer", durationMs };
  return { ok: true, json, durationMs };
}

/** Parse a model answer into a JSON object, tolerating a ```json … ``` fence or
 * surrounding prose. Returns null when no JSON object can be recovered. */
export function parseModelJson(text: string): Record<string, unknown> | null {
  const candidate = stripToJson(text);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stripToJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  // ```json ... ``` or ``` ... ``` fenced block.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  // Otherwise take the outermost { ... } span.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}
