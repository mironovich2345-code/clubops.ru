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
  kktList: "/API/v2/KktList",
  shiftList: "/API/v2/ShiftList",
  documentList: "/API/v2/DocumentList",
  documentInfo: "/API/v2/DocumentInfo",
};

function classifyHttp(status: number): OfdSafeCode {
  if (status === 401) return "auth_failed";
  if (status === 403) return "forbidden";
  if (status === 404) return "kkt_not_found";
  if (status === 429) return "rate_limited";
  return "unknown";
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

export type TaxcomClient = {
  login(): Promise<OfdResult<string>>;
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

  async function raw(path: string, body: unknown, withSession: boolean): Promise<OfdResult<unknown>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (withSession && sessionToken) headers["Session-Token"] = sessionToken;
    let res: Response;
    try {
      res = await fetchImpl(joinUrl(cfg.serverBaseUrl, path), {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return { ok: false, safeCode: timedOut ? "timeout" : "network" };
    }
    if (!res.ok) {
      // Do NOT surface the body (may echo credentials/fiscal content). Status only.
      return { ok: false, safeCode: classifyHttp(res.status), httpStatus: res.status };
    }
    try {
      return { ok: true, data: await res.json() };
    } catch {
      return { ok: false, safeCode: "parse_error" };
    }
  }

  async function ensureSession(): Promise<OfdResult<string>> {
    if (sessionToken) return { ok: true, data: sessionToken };
    const loginBody: Record<string, unknown> = {};
    if (cfg.authType === "integration_token") {
      loginBody.IntegrationToken = cfg.integrationToken ?? "";
      if (cfg.integratorId) loginBody.IntegratorId = cfg.integratorId;
    } else {
      loginBody.Login = cfg.login ?? "";
      loginBody.Pass = cfg.password ?? "";
    }
    const r = await raw(PATHS.login, loginBody, false);
    if (!r.ok) return r;
    const token = extractToken(r.data);
    if (!token) return { ok: false, safeCode: "auth_failed" };
    sessionToken = token;
    return { ok: true, data: token };
  }

  return {
    async login() {
      return ensureSession();
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

function extractToken(data: unknown): string | null {
  const d = data as { SessionToken?: unknown; sessionToken?: unknown; Token?: unknown } | null;
  const t = d?.SessionToken ?? d?.sessionToken ?? d?.Token;
  return typeof t === "string" && t.length > 0 ? t : null;
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
  return asArray(data, "Items", "Kkts", "kkts").map((raw) => {
    const o = raw as Record<string, unknown>;
    return {
      fnNumber: String(o.Fn ?? o.fn ?? o.FnNumber ?? o.fnNumber ?? ""),
      kktRegNumber: str(o.RegNumber ?? o.KktRegNumber ?? o.regNumber),
      kktFactoryNumber: str(o.FactoryNumber ?? o.KktFactoryNumber),
      kktName: str(o.Name ?? o.KktName ?? o.name),
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
