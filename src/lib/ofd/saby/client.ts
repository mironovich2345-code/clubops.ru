// Saby ОФД / СБИС ОФД API client (pilot). Built from the OFFICIAL API docs
// (https://saby.ru/help/ofd/api, base host api.sbis.ru) — NOT scraping the cabinet UI.
// Status: BLOCKED_BY_CREDENTIALS — the endpoint shapes are confirmed but no request with a
// real session has been reconciled in this deployment, and exact auth request/response +
// receipt JSON keys must be verified on a real cabinet (see docs/audits/ofd-saby-integration-
// audit.md). Secrets are never logged; hosts are allow-listed (SSRF); timeouts bounded.
import type { OfdConnectionConfig } from "@/lib/ofd/types";

// SSRF allow-list — Saby requests may ONLY reach these hosts.
export const SABY_API_HOST = "api.sbis.ru";
export const SABY_AUTH_HOST = "online.sbis.ru";
const ALLOWED_HOSTS = new Set([SABY_API_HOST, SABY_AUTH_HOST]);
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type SabyError = { code: string; message: string };
export type SabyResult<T> = { ok: true; data: T } | { ok: false } & SabyError;

/** Normalize any provider/transport failure to a SAFE code + message (no secrets/raw body). */
export function normalizeSabyError(e: unknown): SabyError {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code?: unknown }).code === "string") {
    return { code: String((e as { code: string }).code), message: String((e as { message?: string }).message ?? "Saby error") };
  }
  const msg = e instanceof Error ? e.message : "Unknown Saby error";
  if (/aborted|timeout/i.test(msg)) return { code: "SABY_TIMEOUT", message: "Превышено время ожидания Saby." };
  return { code: "SABY_TRANSPORT", message: "Ошибка связи с Saby." };
}

/** Guard a URL against the SSRF allow-list. Throws on any non-allow-listed host. */
export function assertSabyHost(url: string): void {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw { code: "SABY_BAD_URL", message: "Некорректный адрес Saby." };
  }
  if (!ALLOWED_HOSTS.has(host)) throw { code: "SABY_HOST_BLOCKED", message: "Хост Saby не в списке разрешённых." };
}

// --- confirmed official endpoint builders (base https://api.sbis.ru/ofd/v1) ---
const BASE = `https://${SABY_API_HOST}/ofd/v1`;
export const sabyEndpoints = {
  kkts: (inn: string) => `${BASE}/orgs/${encodeURIComponent(inn)}/kkts`,
  storages: (inn: string, regId: string, status?: string) => `${BASE}/orgs/${encodeURIComponent(inn)}/kkts/${encodeURIComponent(regId)}/storages${status ? `?status=${encodeURIComponent(status)}` : ""}`,
  docs: (inn: string, regId: string, storageId: string) => `${BASE}/orgs/${encodeURIComponent(inn)}/kkts/${encodeURIComponent(regId)}/storages/${encodeURIComponent(storageId)}/docs`,
  docByAttrs: (storageId: string, docNum: string, fiscalSign: string, docDate: string) => `${BASE}/storage/${encodeURIComponent(storageId)}/doc?docNum=${encodeURIComponent(docNum)}&fiscalSign=${encodeURIComponent(fiscalSign)}&docDate=${encodeURIComponent(docDate)}`,
};

export type SabyClientOpts = { fetchImpl?: typeof fetch; timeoutMs?: number; sessionId?: string | null };

/**
 * Minimal Saby client. Auth is passed as the `X-SBISSessionID` header (confirmed from the
 * docs). Acquiring the session (login → sid on online.sbis.ru) needs the exact request body,
 * which must be verified on a real cabinet — until then `authenticate` refuses honestly rather
 * than guessing. Every request is host-checked, timeout-bounded and response-size-capped.
 */
export class SabyOfdClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private sessionId: string | null;

  constructor(opts?: SabyClientOpts) {
    this.fetchImpl = opts?.fetchImpl ?? fetch;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sessionId = opts?.sessionId ?? null;
  }

  /** GET a Saby API url with the session header, host-checked + bounded. */
  async get<T = unknown>(url: string): Promise<SabyResult<T>> {
    try {
      assertSabyHost(url);
      if (!this.sessionId) return { ok: false, code: "SABY_NOT_AUTHENTICATED", message: "Saby: требуется аутентификация." };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, { method: "GET", headers: { "X-SBISSessionID": this.sessionId, Accept: "application/json" }, signal: ctrl.signal });
        if (!res.ok) return { ok: false, code: `SABY_HTTP_${res.status}`, message: `Saby ответил ${res.status}.` };
        const text = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
        return { ok: true, data: JSON.parse(text) as T };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { ok: false, ...normalizeSabyError(e) };
    }
  }

  /**
   * Acquire a session for the connection. The exact online.sbis.ru auth request body is not
   * yet reconciled on a real cabinet, so this refuses rather than fabricating a call — the
   * provider status stays "blocked_by_credentials". Wire the real request here once verified.
   */
  async authenticate(_config: OfdConnectionConfig): Promise<SabyResult<{ sessionId: string }>> {
    return { ok: false, code: "SABY_AUTH_UNVERIFIED", message: "Saby: схема аутентификации не подтверждена на реальном кабинете. Заполните после проверки." };
  }
}
