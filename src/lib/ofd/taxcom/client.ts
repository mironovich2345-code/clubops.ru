// Server-only, isolated Taxcom OFD API client (v2.17). All base URLs come from
// the connection config; the Session-Token, login, password and integration
// token are NEVER logged. Every HTTP error is classified into a safe code. All
// requests go through an injectable `fetchImpl` so tests use a mock (no real API
// call is ever made from this codebase).
//
// NOTE: the exact Taxcom v2.17 REST paths must be confirmed against the account's
// API section. They are declared here as adjustable constants; the request shape,
// auth header and parsing are correct regardless of the final paths.
import type {
  OfdConnectionConfig,
  OfdResult,
  OfdSafeCode,
  TaxcomAccountList,
  TaxcomDocumentInfo,
  TaxcomDocumentSummary,
  TaxcomKkt,
  TaxcomShift,
} from "@/lib/ofd/types";

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 30_000;

// Adjustable endpoint paths (relative to serverBaseUrl). Confirm vs Taxcom v2.17.
const PATHS = {
  login: "/API/v2/Login",
  accountList: "/API/v2/AccountList",
  kktList: "/API/v2/KktList",
  shiftList: "/API/v2/ShiftList",
  documentList: "/API/v2/DocumentList",
  documentInfo: "/API/v2/DocumentInfo",
};

/** Extract ONLY the safe Taxcom error descriptor (apiErrorCode + commonDescription)
 * from a parsed body. Never returns the raw body. */
function extractApiError(data: unknown): { apiErrorCode: number | null; description: string | null } {
  const d = data as Record<string, unknown> | null;
  const rawCode = d?.apiErrorCode ?? d?.ApiErrorCode ?? d?.errorCode;
  const apiErrorCode = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" && rawCode.trim() !== "" && Number.isFinite(Number(rawCode)) ? Number(rawCode) : null;
  const rawDesc = d?.commonDescription ?? d?.CommonDescription ?? d?.description ?? d?.message;
  const description = typeof rawDesc === "string" && rawDesc.trim() ? rawDesc.trim() : null;
  return { apiErrorCode, description };
}

function safeErrorMessage(apiErrorCode: number | null, description: string | null): string | undefined {
  const parts = [apiErrorCode != null ? String(apiErrorCode) : "", description ?? ""].filter(Boolean);
  return parts.length ? parts.join(": ").slice(0, 200) : undefined;
}

/**
 * Classify a Taxcom error into a safe code. "ККТ не найдена" (apiErrorCode 3103,
 * or a 404 on a KKT-scoped call) is NEVER an auth failure. auth_failed / forbidden
 * are reserved for real authorization problems (Login 401/403, invalid/expired
 * Session-Token, explicit access-denied text).
 */
export function classifyTaxcomError(status: number, apiErrorCode: number | null, description: string | null): { safeCode: OfdSafeCode; safeMessage?: string } {
  const desc = (description ?? "").toLowerCase();
  const safeMessage = safeErrorMessage(apiErrorCode, description);
  // 2108 "Ошибка авторизации" — invalid login/password pair. A real auth failure
  // (this is the code Taxcom returned when agreementNumber was wrongly sent).
  if (apiErrorCode === 2108) {
    return { safeCode: "auth_failed", safeMessage };
  }
  // "ККТ не найдена" — apiErrorCode 3103 or a matching description.
  if (apiErrorCode === 3103 || desc.includes("ккт не найдена") || desc.includes("kkt not found")) {
    return { safeCode: "kkt_not_found", safeMessage };
  }
  // 3106 — no KKT available / no access to the KKT in the current session. Not an
  // auth failure: the session is valid, the KKT is just not reachable from it.
  if (apiErrorCode === 3106) {
    return { safeCode: "no_kkt_found", safeMessage };
  }
  // Real authorization problems only.
  if (status === 401 || desc.includes("session-token") || desc.includes("session token") || desc.includes("авториз") || desc.includes("unauthorized") || desc.includes("токен")) {
    return { safeCode: "auth_failed", safeMessage };
  }
  if (status === 403 || desc.includes("доступ запрещ") || desc.includes("forbidden") || desc.includes("access denied")) {
    return { safeCode: "forbidden", safeMessage };
  }
  if (status === 429) return { safeCode: "rate_limited", safeMessage };
  // A 404 on our KKT-scoped calls (shift/document lists) means the KKT is not in
  // the CURRENT agreement/session — not an auth failure.
  if (status === 404) return { safeCode: "kkt_not_found", safeMessage };
  return { safeCode: "unknown", safeMessage };
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

export type TaxcomClient = {
  login(): Promise<OfdResult<string>>;
  listAccounts(): Promise<OfdResult<TaxcomAccountList>>;
  listKkt(): Promise<OfdResult<TaxcomKkt[]>>;
  listShifts(fnNumber: string, dateFrom: string, dateTo: string): Promise<OfdResult<TaxcomShift[]>>;
  listDocumentsByShift(fnNumber: string, shiftNumber: number): Promise<OfdResult<TaxcomDocumentSummary[]>>;
  getDocumentInfo(fnNumber: string, fd: number): Promise<OfdResult<TaxcomDocumentInfo>>;
};

/**
 * Create a Taxcom client bound to one connection. The Session-Token is obtained
 * lazily on the first authenticated call and cached in memory for this instance
 * (never persisted, never logged).
 */
export function createTaxcomClient(cfg: OfdConnectionConfig, opts?: { fetchImpl?: FetchImpl; timeoutMs?: number }): TaxcomClient {
  const fetchImpl: FetchImpl = opts?.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let sessionToken: string | null = null;

  async function raw(path: string, body: unknown, withSession: boolean, method: "POST" | "GET" = "POST"): Promise<OfdResult<unknown>> {
    const headers: Record<string, string> = {};
    if (method === "POST") headers["Content-Type"] = "application/json";
    // Integrator-ID is required by Taxcom on Login and accepted on later calls.
    if (cfg.integratorId) headers["Integrator-ID"] = cfg.integratorId;
    if (withSession && sessionToken) headers["Session-Token"] = sessionToken;
    let res: Response;
    try {
      res = await fetchImpl(joinUrl(cfg.serverBaseUrl, path), {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return { ok: false, safeCode: timedOut ? "timeout" : "network" };
    }

    // Read the body ONCE. Only the safe error descriptor (apiErrorCode +
    // commonDescription) is ever extracted — the raw body is never returned/logged.
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = null;
    }
    const { apiErrorCode, description } = extractApiError(parsed);

    // Taxcom may return an API-level error with HTTP 200 (apiErrorCode set) OR a
    // non-2xx status. Both are classified the same way.
    if (!res.ok || (apiErrorCode != null && apiErrorCode !== 0)) {
      const c = classifyTaxcomError(res.status, apiErrorCode, description);
      return { ok: false, safeCode: c.safeCode, safeMessage: c.safeMessage, httpStatus: res.status };
    }
    if (parsed == null) return { ok: false, safeCode: "parse_error", httpStatus: res.status };
    return { ok: true, data: parsed };
  }

  async function ensureSession(): Promise<OfdResult<string>> {
    if (sessionToken) return { ok: true, data: sessionToken };
    // Taxcom Login body is ONLY { login, password } (Integrator-ID is a HEADER,
    // added in raw()). agreementNumber must NOT be sent here — Taxcom rejects it
    // with apiErrorCode 2108 "Ошибка авторизации". The target agreement/договор is
    // verified separately via AccountList (see checkOfdConnection), not at Login.
    const loginBody: Record<string, unknown> = {};
    if (cfg.authType === "integration_token") {
      loginBody.integrationToken = cfg.integrationToken ?? "";
    } else {
      loginBody.login = cfg.login ?? "";
      loginBody.password = cfg.password ?? "";
    }

    const r = await raw(PATHS.login, loginBody, false);
    if (!r.ok) return r;
    const token = extractToken(r.data);
    if (!token) return { ok: false, safeCode: "parse_error" }; // 200 but no token
    sessionToken = token;
    return { ok: true, data: token };
  }

  return {
    async login() {
      return ensureSession();
    },
    async listAccounts() {
      const s = await ensureSession();
      if (!s.ok) return s;
      const r = await raw(PATHS.accountList, null, true, "GET");
      if (!r.ok) return r;
      return { ok: true, data: parseAccountList(r.data) };
    },
    async listKkt() {
      const s = await ensureSession();
      if (!s.ok) return s;
      const r = await raw(PATHS.kktList, {}, true);
      if (!r.ok) return r;
      return { ok: true, data: parseKktList(r.data) };
    },
    async listShifts(fnNumber, dateFrom, dateTo) {
      const s = await ensureSession();
      if (!s.ok) return s;
      const r = await raw(PATHS.shiftList, { Fn: fnNumber, DateFrom: dateFrom, DateTo: dateTo }, true);
      if (!r.ok) return r;
      return { ok: true, data: parseShiftList(r.data) };
    },
    async listDocumentsByShift(fnNumber, shiftNumber) {
      const s = await ensureSession();
      if (!s.ok) return s;
      const r = await raw(PATHS.documentList, { Fn: fnNumber, Shift: shiftNumber }, true);
      if (!r.ok) return r;
      return { ok: true, data: parseDocumentList(r.data) };
    },
    async getDocumentInfo(fnNumber, fd) {
      const s = await ensureSession();
      if (!s.ok) return s;
      const r = await raw(PATHS.documentInfo, { Fn: fnNumber, Fd: fd }, true);
      if (!r.ok) return r;
      return { ok: true, data: parseDocumentInfo(r.data) };
    },
  };
}

// --- Response parsers (defensive; accept common Taxcom field casings) --------

export function extractToken(data: unknown): string | null {
  const d = data as { sessionToken?: unknown; SessionToken?: unknown; token?: unknown; accessToken?: unknown; Token?: unknown } | null;
  // Primary Taxcom key is `sessionToken`; accept common casings/aliases.
  const t = d?.sessionToken ?? d?.SessionToken ?? d?.token ?? d?.accessToken ?? d?.Token;
  return typeof t === "string" && t.length > 0 ? t : null;
}

/** Parse AccountList into the current session's agreement + the available ЛК.
 * SAFE fields only (agreementNumber / companyName / inn / kpp) — access rights,
 * counts and the raw payload are never surfaced. */
export function parseAccountList(data: unknown): TaxcomAccountList {
  const d = (data as Record<string, unknown>) ?? {};
  const session = (d.currentSession ?? d.CurrentSession ?? d.current ?? null) as Record<string, unknown> | null;
  const currentAgreementNumber =
    str(session?.agreementNumber ?? session?.AgreementNumber) ??
    str(d.currentAgreementNumber ?? d.CurrentAgreementNumber);
  const records = asArray(data, "records", "Records", "Items", "items", "accounts", "Accounts").map((raw) => {
    const o = raw as Record<string, unknown>;
    return {
      agreementNumber: str(o.agreementNumber ?? o.AgreementNumber ?? o.contractNumber ?? o.ContractNumber),
      companyName: str(o.companyName ?? o.CompanyName ?? o.orgName ?? o.OrgName ?? o.name ?? o.Name),
      inn: str(o.inn ?? o.Inn ?? o.INN),
      kpp: str(o.kpp ?? o.Kpp ?? o.KPP),
    };
  });
  return { currentAgreementNumber, records };
}

function asArray(data: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  const d = data as Record<string, unknown> | null;
  for (const k of keys) if (Array.isArray(d?.[k])) return d![k] as unknown[];
  return [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function parseKktList(data: unknown): TaxcomKkt[] {
  // kktstat/kktinfo returns the list under "Infos"; other calls use Items/Kkts.
  return asArray(data, "Infos", "infos", "Items", "Kkts", "kkts").map((raw) => {
    const o = raw as Record<string, unknown>;
    return {
      fnNumber: String(o.Fn ?? o.fn ?? o.FnNumber ?? o.fnNumber ?? o.FnFactoryNumber ?? o.fnFactoryNumber ?? ""),
      kktRegNumber: str(o.KktRegNumber ?? o.kktRegNumber ?? o.RegNumber ?? o.regNumber),
      kktFactoryNumber: str(o.FnFactoryNumber ?? o.fnFactoryNumber ?? o.FactoryNumber ?? o.KktFactoryNumber),
      kktName: str(o.KktName ?? o.kktName ?? o.Name ?? o.name),
      outletId: str(o.OutletId ?? o.outletId),
      outletName: str(o.OutletName ?? o.outletName),
      outletAddress: str(o.OutletAddress ?? o.outletAddress),
    };
  }).filter((k) => k.fnNumber);
}

export function parseShiftList(data: unknown): TaxcomShift[] {
  return asArray(data, "Items", "Shifts", "shifts").map((raw) => {
    const o = raw as Record<string, unknown>;
    return {
      shiftNumber: num(o.Shift ?? o.ShiftNumber ?? o.shift ?? o.number),
      dateOpen: str(o.DateOpen ?? o.dateOpen),
      dateClose: str(o.DateClose ?? o.dateClose),
    };
  }).filter((s) => Number.isFinite(s.shiftNumber));
}

/** Parse a DocumentList payload into safe per-receipt summaries. */
export function parseDocumentList(data: unknown): TaxcomDocumentSummary[] {
  return asArray(data, "Items", "Documents", "documents").map((raw) => {
    const o = raw as Record<string, unknown>;
    return {
      fn: String(o.Fn ?? o.fn ?? ""),
      shift: num(o.Shift ?? o.shift),
      type: str(o.Type ?? o.type),
      dateTime: String(o.DateTime ?? o.dateTime ?? o.Date ?? o.date ?? ""),
      fd: num(o.Fd ?? o.fd ?? o.FiscalDocumentNumber),
      fpd: str(o.Fpd ?? o.fpd ?? o.FiscalSign),
      operationType: str(o.OperationType ?? o.operationType ?? o.Operation),
      totalKopeks: num(o.TotalKopeks ?? o.totalKopeks ?? o.Sum ?? o.Total),
      cashKopeks: num(o.CashKopeks ?? o.cashKopeks ?? o.Cash),
      electronicKopeks: num(o.ElectronicKopeks ?? o.electronicKopeks ?? o.Electronic),
    };
  });
}

export function parseDocumentInfo(data: unknown): TaxcomDocumentInfo {
  const o = (data as Record<string, unknown>) ?? {};
  return {
    fn: String(o.Fn ?? o.fn ?? ""),
    fd: num(o.Fd ?? o.fd),
    fpd: str(o.Fpd ?? o.fpd),
    operationType: str(o.OperationType ?? o.operationType),
    totalKopeks: num(o.TotalKopeks ?? o.totalKopeks ?? o.Total),
    cashKopeks: num(o.CashKopeks ?? o.cashKopeks),
    electronicKopeks: num(o.ElectronicKopeks ?? o.electronicKopeks),
  };
}
