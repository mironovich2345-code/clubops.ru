// Server-only Astral.ОФД API client (v4.2, Z-report v4.1). Endpoints, methods and
// field names are taken from the official «Документация Астрал ОФД API.pdf».
//
// Contract (from the PDF):
//   - Base URL:  https://ofd.astralnalog.ru/api/v4.2   (document.zReport is /api/v4.1)
//   - Every method is POST; parameters go in a JSON body.
//   - Auth is the `api_key` body parameter (never a header, never a query string).
//   - Success: { "ok": true,  "result": {...} }
//   - Error:   { "ok": false, "error_code": 403, "description": "..." }
//
// SECURITY: the api_key is NEVER logged and NEVER placed in an error message or a
// safe code. All requests go through an injectable `fetchImpl` so tests never hit
// the real API. Parsing is tolerant (string|number|boolean) because the PDF shows
// the same field as a string in one response and a number in another (e.g.
// totalCount, fiscalSign, operationType).
import { decryptOfdSecret } from "@/lib/ofd/crypto";

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export const ASTRAL_BASE_URL_V42 = "https://ofd.astralnalog.ru/api/v4.2";
export const ASTRAL_BASE_URL_V41 = "https://ofd.astralnalog.ru/api/v4.1";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4; // 1 try + 3 retries (5xx / timeout / network only)
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 5_000;

/** Internal, safe error codes surfaced to callers/UI. NEVER contains the api_key. */
export type AstralErrorCode =
  | "ASTRAL_INVALID_API_KEY"
  | "ASTRAL_ACCESS_DENIED"
  | "ASTRAL_RATE_LIMITED"
  | "ASTRAL_TIMEOUT"
  | "ASTRAL_SERVICE_UNAVAILABLE"
  | "ASTRAL_INVALID_RESPONSE"
  | "ASTRAL_ORGANIZATION_NOT_FOUND"
  | "ASTRAL_ALIAS_NOT_FOUND"
  | "ASTRAL_KKT_NOT_FOUND"
  | "ASTRAL_PAGINATION_ERROR"
  | "ASTRAL_MAPPING_REQUIRED"
  | "ASTRAL_UNKNOWN_DOCUMENT_TYPE"
  | "ASTRAL_SYNC_PARTIAL_FAILURE"
  | "ASTRAL_NOT_CONFIGURED"
  | "ASTRAL_NETWORK"
  | "ASTRAL_UNKNOWN";

export type AstralResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: AstralErrorCode; message: string; httpStatus?: number; apiErrorCode?: number | null; referenceId?: string };

// ---- tolerant primitive coercion (PDF mixes string / number / boolean) -------

/** Number() only when the value is a finite numeric string/number; else fallback. */
export function toNum(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return fallback;
    const n = Number(t);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** Integer variant (rounds); safe for kopeks / counts. */
export function toInt(v: unknown, fallback = 0): number {
  return Math.round(toNum(v, fallback));
}

/** A `totalCount` that may arrive as `"1"` or `1`. Never NaN. */
export function toCount(v: unknown): number {
  const n = toInt(v, 0);
  return n >= 0 ? n : 0;
}

export function toStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** Nullable string — keeps null distinct from "" so callers can tell "absent". */
export function toStrOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

export function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return t === "true" || t === "1" || t === "yes";
  }
  return false;
}

// ---- error classification ----------------------------------------------------

/** Map an HTTP status + Astral error_code into a safe internal code. Retryable
 * conditions (5xx / timeout / network) are handled by the retry loop, NOT here. */
export function classifyAstralError(httpStatus: number | null, apiErrorCode: number | null): AstralErrorCode {
  const code = apiErrorCode ?? httpStatus ?? 0;
  switch (code) {
    case 401:
      return "ASTRAL_INVALID_API_KEY";
    case 403:
      return "ASTRAL_ACCESS_DENIED";
    case 404:
      return "ASTRAL_KKT_NOT_FOUND"; // caller may re-map to ORGANIZATION/ALIAS not found by context
    case 429:
      return "ASTRAL_RATE_LIMITED";
    case 400:
      return "ASTRAL_INVALID_RESPONSE";
  }
  if (httpStatus != null && httpStatus >= 500) return "ASTRAL_SERVICE_UNAVAILABLE";
  if (httpStatus === 429) return "ASTRAL_RATE_LIMITED";
  return "ASTRAL_UNKNOWN";
}

/** True for transient conditions worth a bounded retry. */
export function isRetryableStatus(httpStatus: number): boolean {
  return httpStatus >= 500 || httpStatus === 429;
}

/** Deterministic bounded backoff (no Math.random — that is unavailable in some
 * runtimes and makes tests non-reproducible). Attempt is 1-based. */
export function backoffMs(attempt: number): number {
  const exp = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(exp, BACKOFF_CAP_MS);
}

/** Redact anything that looks like an api_key from a would-be log/message. Defence
 * in depth — the client never puts the key in a message, but a raw description from
 * the server could in theory echo it. */
export function redactApiKey(s: string, apiKey: string | null): string {
  if (!s) return s;
  let out = s;
  if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join("***");
  return out.replace(/("?api_?key"?\s*[:=]\s*)"?[^"\s,&]+/gi, "$1***");
}

// ---- request-id -------------------------------------------------------------

let __seq = 0;
/** Monotonic per-process reference id for structured logs. No Date.now()/random
 * (unavailable in some runtimes); the sequence + connectionId is enough to trace. */
function nextReferenceId(connectionId: string): string {
  __seq = (__seq + 1) % 1_000_000;
  return `astral-${connectionId.slice(0, 8)}-${__seq.toString(36)}`;
}

// ---- client -----------------------------------------------------------------

export type AstralClientConfig = {
  connectionId: string;
  apiKey: string; // DECRYPTED, in memory only for the call. Never logged.
  baseUrl?: string; // defaults to v4.2
};

export type AstralClientOpts = {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Injectable sleeper so tests don't actually wait for backoff. */
  sleep?: (ms: number) => Promise<void>;
};

export type AstralClient = {
  /** Low-level POST. `path` is a method name like "organization.list" (v4.2) or an
   * absolute-ish "v4.1/document.zReport". Returns the `result` payload on success. */
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<AstralResult<T>>;
};

/** Build an Astral client bound to one connection's decrypted api_key. */
export function createAstralClient(cfg: AstralClientConfig, opts: AstralClientOpts = {}): AstralClient {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const baseV42 = (cfg.baseUrl ?? ASTRAL_BASE_URL_V42).replace(/\/+$/, "");

  function urlFor(method: string): string {
    // "v4.1/document.zReport" → v4.1 host; plain "organization.list" → v4.2 base.
    if (method.startsWith("v4.1/")) return `${ASTRAL_BASE_URL_V41}/${method.slice("v4.1/".length)}`;
    return `${baseV42}/${method}`;
  }

  async function call<T>(method: string, params: Record<string, unknown>): Promise<AstralResult<T>> {
    const referenceId = nextReferenceId(cfg.connectionId);
    const url = urlFor(method);
    // Body carries api_key + params. We build a redacted copy of the *param keys*
    // (never values) for structured logging.
    const body = { api_key: cfg.apiKey, ...params };
    const paramKeys = Object.keys(params);

    let lastErr: AstralResult<T> | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        lastErr = { ok: false, code: timedOut ? "ASTRAL_TIMEOUT" : "ASTRAL_NETWORK", message: timedOut ? "Astral: превышено время ожидания." : "Astral: сетевая ошибка.", referenceId };
        console.warn(`[ofd-astral] request_error method=${method} ref=${referenceId} attempt=${attempt}/${maxAttempts} kind=${timedOut ? "timeout" : "network"} keys=${paramKeys.join(",")}`);
        // Retry timeout/network.
        if (attempt < maxAttempts) { await sleep(backoffMs(attempt)); continue; }
        return lastErr;
      }

      const httpStatus = res.status;
      const text = await res.text().catch(() => "");

      // Retryable HTTP status (5xx / 429) → backoff then retry.
      if (isRetryableStatus(httpStatus)) {
        lastErr = { ok: false, code: classifyAstralError(httpStatus, null), message: `Astral: сервис временно недоступен (HTTP ${httpStatus}).`, httpStatus, referenceId };
        console.warn(`[ofd-astral] http_retryable method=${method} ref=${referenceId} attempt=${attempt}/${maxAttempts} status=${httpStatus}`);
        if (attempt < maxAttempts) { await sleep(backoffMs(attempt)); continue; }
        return lastErr;
      }

      // Parse JSON defensively — never throw on malformed bodies.
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        console.warn(`[ofd-astral] invalid_json method=${method} ref=${referenceId} status=${httpStatus} bytes=${text.length}`);
        return { ok: false, code: "ASTRAL_INVALID_RESPONSE", message: "Astral: некорректный ответ сервера (не JSON).", httpStatus, referenceId };
      }
      const env = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      const ok = toBool(env.ok);
      const apiErrorCode = env.error_code != null ? toInt(env.error_code) : null;

      // Non-2xx that isn't retryable (400/401/403/404) OR ok=false with HTTP 200.
      if (!res.ok || !ok) {
        const code = classifyAstralError(res.ok ? null : httpStatus, apiErrorCode);
        const rawDesc = toStr(env.description);
        const message = redactApiKey(rawDesc || `Astral: запрос отклонён (код ${apiErrorCode ?? httpStatus}).`, cfg.apiKey).slice(0, 200);
        console.warn(`[ofd-astral] api_error method=${method} ref=${referenceId} status=${httpStatus} error_code=${apiErrorCode ?? "-"} code=${code}`);
        // 401/403/404/400 are terminal — never retry (per spec).
        return { ok: false, code, message, httpStatus, apiErrorCode, referenceId };
      }

      // Success.
      console.warn(`[ofd-astral] ok method=${method} ref=${referenceId} status=${httpStatus} keys=${paramKeys.join(",")}`);
      return { ok: true, data: (env.result as T) ?? (null as unknown as T) };
    }
    // Loop exhausted (all attempts consumed by retryable failures).
    return lastErr ?? { ok: false, code: "ASTRAL_UNKNOWN", message: "Astral: неизвестная ошибка.", referenceId };
  }

  return { call };
}

/** Convenience: build a client from an encrypted token column. Returns null if the
 * token can't be decrypted (mis-set OFD_SECRET / empty), so callers fail honestly. */
export function createAstralClientFromEncrypted(
  connectionId: string,
  integrationTokenEncrypted: string | null,
  opts: AstralClientOpts = {},
): AstralClient | null {
  const apiKey = decryptOfdSecret(integrationTokenEncrypted);
  if (!apiKey) return null;
  return createAstralClient({ connectionId, apiKey }, opts);
}
