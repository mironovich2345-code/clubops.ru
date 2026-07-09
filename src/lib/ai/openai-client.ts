// Server-only OpenAI Vision helper. The API key is read from the environment and
// never logged or exposed to the client. Used by the invoice/expense analyzers.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_FALLBACK_MODEL = "gpt-4o";

/** Invoice AI models are chosen ONLY from server env (never the client). */
export function invoiceAiModels(): { primary: string; fallback: string } {
  return {
    primary: process.env.INVOICE_AI_PRIMARY_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL,
    fallback: process.env.INVOICE_AI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL,
  };
}

export function aiTimeoutMs(): number {
  const n = Number(process.env.INVOICE_AI_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5_000 && n <= 120_000 ? n : 60_000;
}

// "openai" — dev/test only (data leaves RU jurisdiction; see COMPLIANCE_RU.md).
// "ru_ai" — production placeholder for a Russian AI/OCR provider (not yet
//           implemented; analyzers fall back to mock until it is wired up).
// "mock"  — safe default, no external calls.
export type AiProvider = "openai" | "ru_ai" | "mock";

let warnedOpenAiInProd = false;

/** Logs the legal-basis warning once when OpenAI is enabled in production. */
function warnOpenAiInProduction(): void {
  if (warnedOpenAiInProd) return;
  if (process.env.NODE_ENV === "production") {
    console.warn("OpenAI is enabled. Do not process personal data without legal basis.");
    warnedOpenAiInProd = true;
  }
}

/**
 * Selects the AI provider from the environment:
 *  - "openai" only when AI_PROVIDER=openai and OPENAI_API_KEY is set (dev/test).
 *  - "ru_ai"  when AI_PROVIDER=ru_ai with RU_AI_ENDPOINT + RU_AI_API_KEY set
 *    (production target; currently a placeholder — see ru-ai-client notes).
 *  - "mock"   otherwise (safe default).
 */
export function selectedAiProvider(): AiProvider {
  if (process.env.AI_PROVIDER === "openai" && process.env.OPENAI_API_KEY) {
    warnOpenAiInProduction();
    return "openai";
  }
  if (process.env.AI_PROVIDER === "ru_ai" && process.env.RU_AI_ENDPOINT && process.env.RU_AI_API_KEY) {
    return "ru_ai";
  }
  return "mock";
}

export function isPdf(mime: string): boolean {
  return mime === "application/pdf";
}

export function bufferToDataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

export type VisionCall =
  | { ok: true; json: Record<string, unknown>; raw: string }
  | { ok: false; reason: "config" | "http" | "network" | "parse" | "timeout"; raw: string; message: string };

/**
 * Calls OpenAI vision with a JSON-only response format. Returns a discriminated
 * result; the caller decides whether to use the data, show a low-confidence
 * warning (bad JSON), or fall back to the mock (network/HTTP errors).
 */
async function chatCompletion(messages: unknown[], model: string, timeoutMs: number): Promise<VisionCall> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, reason: "config", raw: "", message: "OPENAI_API_KEY missing" };

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0, response_format: { type: "json_object" }, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, reason: timedOut ? "timeout" : "network", raw: "", message: error instanceof Error ? error.message : "network error" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, reason: "http", raw: body.slice(0, 1000), message: `OpenAI HTTP ${res.status}` };
  }
  const data = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
  const content = data?.choices?.[0]?.message?.content ?? "";
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, json: parsed as Record<string, unknown>, raw: content };
    return { ok: false, reason: "parse", raw: content, message: "Model did not return a JSON object" };
  } catch {
    return { ok: false, reason: "parse", raw: content, message: "Model returned invalid JSON" };
  }
}

/** Vision call (one image) with JSON-only output. Model + timeout are explicit. */
export async function callOpenAIVision(params: { system: string; user: string; dataUrl: string; model?: string; timeoutMs?: number }): Promise<VisionCall> {
  return chatCompletion(
    [
      { role: "system", content: params.system },
      { role: "user", content: [{ type: "text", text: params.user }, { type: "image_url", image_url: { url: params.dataUrl } }] },
    ],
    params.model || invoiceAiModels().primary,
    params.timeoutMs ?? aiTimeoutMs(),
  );
}

/** Text-only call (extracted PDF text) with JSON-only output. The document text
 * is passed as untrusted content — the system prompt forbids obeying it. */
export async function callOpenAIText(params: { system: string; user: string; model?: string; timeoutMs?: number }): Promise<VisionCall> {
  return chatCompletion(
    [
      { role: "system", content: params.system },
      { role: "user", content: params.user },
    ],
    params.model || invoiceAiModels().primary,
    params.timeoutMs ?? aiTimeoutMs(),
  );
}
