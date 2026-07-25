// Astral.ОФД catalog + connection methods, built on the low-level client. Each method
// maps one PDF endpoint to a normalized, paginated result. NO secrets are returned.
//
//   organization.list      → listOrganizations   (testConnection uses this)
//   kkt.aliasList          → listOutlets          (торговые точки)
//   kkt.search             → listKkts             (все кассы организации)
//   kkt.listByAlias        → listKktsByAlias       (кассы торговой точки)
//   kkt.getById            → getKktById            (детали/диагностика)
import type { OfdConnectionConfig } from "@/lib/ofd/types";
import {
  createAstralClient,
  toCount,
  toInt,
  type AstralClient,
  type AstralClientOpts,
  type AstralResult,
} from "@/lib/ofd/astral/client";
import {
  normalizeOrganization,
  normalizeOutlet,
  normalizeKkt,
  type AstralOrganization,
  type AstralOutlet,
  type AstralKkt,
} from "@/lib/ofd/astral/normalize";

export type Paged<T> = { items: T[]; totalCount: number; page: number; count: number };

/** Build a client for a connection config (its decrypted integrationToken = api_key). */
export function astralClientForConfig(config: OfdConnectionConfig, opts?: AstralClientOpts): AstralClient | null {
  const apiKey = config.integrationToken;
  if (!apiKey) return null;
  return createAstralClient({ connectionId: config.id, apiKey }, opts);
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [];
}

// ---- organizations -----------------------------------------------------------

export type ListOrgsParams = { search?: string; page?: number; count?: number };

/** POST /organization.list. Success requires ok=true AND result.organizations array. */
export async function listOrganizations(client: AstralClient, params: ListOrgsParams = {}): Promise<AstralResult<Paged<AstralOrganization>>> {
  const page = params.page ?? 1;
  const count = params.count ?? 50;
  const res = await client.call<Record<string, unknown>>("organization.list", {
    search: params.search ?? "",
    page: String(page),
    count,
  });
  if (!res.ok) return res;
  const orgsRaw = (res.data as Record<string, unknown> | null)?.organizations;
  if (!Array.isArray(orgsRaw)) {
    return { ok: false, code: "ASTRAL_INVALID_RESPONSE", message: "Astral: ответ organization.list не содержит массив organizations." };
  }
  const items = arr(orgsRaw).map(normalizeOrganization);
  const totalCount = toCount((res.data as Record<string, unknown>)?.totalCount ?? items.length);
  return { ok: true, data: { items, totalCount, page, count } };
}

// ---- outlets (kkt.aliasList) -------------------------------------------------

export type ListOutletsParams = { organizationId: string; pageNumber?: number; count?: number };

export async function listOutlets(client: AstralClient, params: ListOutletsParams): Promise<AstralResult<Paged<AstralOutlet>>> {
  const page = params.pageNumber ?? 1;
  const count = params.count ?? 50;
  const res = await client.call<Record<string, unknown>>("kkt.aliasList", {
    organizationId: Number(params.organizationId),
    pageNumber: page,
    count,
  });
  if (!res.ok) return res.code === "ASTRAL_KKT_NOT_FOUND" ? { ...res, code: "ASTRAL_ALIAS_NOT_FOUND" } : res;
  const aliasesRaw = (res.data as Record<string, unknown> | null)?.aliases;
  if (!Array.isArray(aliasesRaw)) {
    return { ok: false, code: "ASTRAL_INVALID_RESPONSE", message: "Astral: ответ kkt.aliasList не содержит массив aliases." };
  }
  const items = arr(aliasesRaw).map(normalizeOutlet);
  const totalCount = toCount((res.data as Record<string, unknown>)?.totalCount ?? items.length);
  return { ok: true, data: { items, totalCount, page, count } };
}

// ---- KKTs (kkt.search) -------------------------------------------------------

export type ListKktsParams = { organizationId: string; page?: number; count?: number; search?: string };

export async function listKkts(client: AstralClient, params: ListKktsParams): Promise<AstralResult<Paged<AstralKkt>>> {
  const page = params.page ?? 1;
  const count = params.count ?? 50;
  const res = await client.call<Record<string, unknown>>("kkt.search", {
    organizationId: Number(params.organizationId),
    page,
    count,
    ...(params.search ? { search: params.search } : {}),
  });
  if (!res.ok) return res;
  const kktsRaw = (res.data as Record<string, unknown> | null)?.kkts;
  if (!Array.isArray(kktsRaw)) {
    return { ok: false, code: "ASTRAL_INVALID_RESPONSE", message: "Astral: ответ kkt.search не содержит массив kkts." };
  }
  const items = arr(kktsRaw).map(normalizeKkt);
  const totalCount = toCount((res.data as Record<string, unknown>)?.totalCount ?? items.length);
  return { ok: true, data: { items, totalCount, page, count } };
}

// ---- KKTs of one outlet (kkt.listByAlias) ------------------------------------

export type ListKktsByAliasParams = { organizationId: string; aliasId: string; page?: number; count?: number };

export async function listKktsByAlias(client: AstralClient, params: ListKktsByAliasParams): Promise<AstralResult<Paged<AstralKkt>>> {
  const page = params.page ?? 1;
  const count = params.count ?? 50;
  const res = await client.call<Record<string, unknown>>("kkt.listByAlias", {
    organizationId: String(params.organizationId),
    aliasId: String(params.aliasId),
    page,
    count: String(count),
  });
  if (!res.ok) return res.code === "ASTRAL_KKT_NOT_FOUND" ? { ...res, code: "ASTRAL_ALIAS_NOT_FOUND" } : res;
  const kktsRaw = (res.data as Record<string, unknown> | null)?.kkts;
  if (!Array.isArray(kktsRaw)) {
    return { ok: false, code: "ASTRAL_INVALID_RESPONSE", message: "Astral: ответ kkt.listByAlias не содержит массив kkts." };
  }
  const items = arr(kktsRaw).map(normalizeKkt);
  const totalCount = toCount((res.data as Record<string, unknown>)?.totalCount ?? items.length);
  return { ok: true, data: { items, totalCount, page, count } };
}

// ---- single KKT (kkt.getById) ------------------------------------------------

export async function getKktById(client: AstralClient, id: string): Promise<AstralResult<AstralKkt>> {
  const res = await client.call<Record<string, unknown>>("kkt.getById", { id: String(id) });
  if (!res.ok) return res;
  if (!res.data || typeof res.data !== "object") {
    return { ok: false, code: "ASTRAL_INVALID_RESPONSE", message: "Astral: пустой ответ kkt.getById." };
  }
  return { ok: true, data: normalizeKkt(res.data as Record<string, unknown>) };
}

// ---- fiscal documents (documents.tickets) — one page -------------------------

export type FetchReceiptsPageParams = {
  organizationId: string;
  pageNumber: number;
  count: number;
  beginDate: number; // unix seconds
  endDate: number; // unix seconds
  kkts?: number[]; // external KKT ids
  aliasId?: number[]; // external outlet ids
  fiscalDriveNumber?: string[]; // ФН numbers
  operationTypes?: string[]; // Cyrillic ["Приход","Возврат прихода"]
  orderBy?: string; // default "dateTime"
  order?: "asc" | "desc"; // default "asc"
};

/** Build the documents.tickets request body (WITHOUT api_key — the client adds it).
 * Exported so callers can trace/inspect the exact request safely. */
export function buildTicketsBody(params: FetchReceiptsPageParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    organizationId: String(params.organizationId),
    pageNumber: String(params.pageNumber),
    count: String(params.count),
    orderBy: params.orderBy ?? "dateTime",
    order: params.order ?? "asc",
    beginDate: String(params.beginDate),
    endDate: String(params.endDate),
  };
  if (params.kkts && params.kkts.length) body.kkts = params.kkts;
  if (params.aliasId && params.aliasId.length) body.aliasId = params.aliasId;
  if (params.fiscalDriveNumber && params.fiscalDriveNumber.length) body.fiscalDriveNumber = params.fiscalDriveNumber;
  if (params.operationTypes && params.operationTypes.length) body.operationTypes = params.operationTypes;
  return body;
}

/** One page of POST /documents.tickets. Returns the RAW document objects (the caller
 * normalizes) + totalCount (string|number → number). The FIRST/preview request should
 * pass NO optional filters (operationTypes/documentType) — classification happens
 * locally on the full response, so a server-side enum mismatch cannot zero out results. */
export async function fetchReceiptsPage(
  client: AstralClient,
  params: FetchReceiptsPageParams,
): Promise<AstralResult<{ documents: Record<string, unknown>[]; totalCount: number }>> {
  const body = buildTicketsBody(params);
  // SAFE trace (never the api_key — the client adds it, `body` has none).
  console.warn(`[ofd-astral] tickets_request endpoint=documents.tickets orgId=${body.organizationId} page=${body.pageNumber} count=${body.count} beginDate=${body.beginDate} endDate=${body.endDate} kkts=${JSON.stringify(body.kkts ?? null)} fiscalDriveNumber=${JSON.stringify(body.fiscalDriveNumber ?? null)} operationTypes=${JSON.stringify(body.operationTypes ?? null)}`);

  const res = await client.call<Record<string, unknown>>("documents.tickets", body);
  if (!res.ok) return res;
  const docsRaw = (res.data as Record<string, unknown> | null)?.documents;
  if (!Array.isArray(docsRaw)) {
    return { ok: false, code: "ASTRAL_INVALID_RESPONSE", message: "Astral: ответ documents.tickets не содержит массив documents." };
  }
  const documents = arr(docsRaw);
  const totalCount = toCount((res.data as Record<string, unknown>)?.totalCount ?? documents.length);
  return { ok: true, data: { documents, totalCount } };
}

// ---- A/B/C diagnostic probe --------------------------------------------------

export type AstralProbeStep = {
  step: "A_org_only" | "B_with_kkts" | "C_with_operationTypes";
  ok: boolean;
  documents: number;
  totalCount: number;
  httpStatus?: number;
  code?: string;
  description?: string;
  body: Record<string, unknown>; // safe: never contains api_key
};

/**
 * Sequential diagnostic per §4: run documents.tickets for the SAME day with widening
 * filters and report where documents disappear.
 *   A: organizationId + date + paging only (no kkts / operationTypes)
 *   B: + kkts[]  (internal Astral KKT ids)
 *   C: + operationTypes  (production sales filter)
 * Read-only, imports nothing. Each step returns a SAFE trace (no api_key).
 */
export async function probeAstralDocuments(
  client: AstralClient,
  params: { organizationId: string; beginDate: number; endDate: number; kkts?: number[]; operationTypes?: string[]; count?: number },
): Promise<AstralProbeStep[]> {
  const count = params.count ?? 100;
  const base = { organizationId: params.organizationId, pageNumber: 1, count, beginDate: params.beginDate, endDate: params.endDate };
  const variants: Array<{ step: AstralProbeStep["step"]; p: FetchReceiptsPageParams }> = [
    { step: "A_org_only", p: { ...base } },
    { step: "B_with_kkts", p: { ...base, kkts: params.kkts } },
    { step: "C_with_operationTypes", p: { ...base, kkts: params.kkts, operationTypes: params.operationTypes ?? undefined } },
  ];
  const out: AstralProbeStep[] = [];
  for (const v of variants) {
    const body = buildTicketsBody(v.p);
    const res = await fetchReceiptsPage(client, v.p);
    if (res.ok) out.push({ step: v.step, ok: true, documents: res.data.documents.length, totalCount: res.data.totalCount, body });
    else out.push({ step: v.step, ok: false, documents: 0, totalCount: 0, httpStatus: res.httpStatus, code: res.code, description: res.message, body });
  }
  return out;
}

// ---- closed shifts (documents.closedShiftsList) — reconciliation -------------

export type AstralClosedShiftsSummary = {
  shiftCount: number;
  checkCount: number;
  sumKopeks: number;
  cashKopeks: number;
  ecashKopeks: number;
};

/** Aggregate closed shifts over a range for reconciliation (NOT the receipt source). */
export async function fetchClosedShifts(
  client: AstralClient,
  params: { organizationId: string; beginDate: number; endDate: number; count?: number },
): Promise<AstralResult<AstralClosedShiftsSummary>> {
  const res = await client.call<Record<string, unknown>>("documents.closedShiftsList", {
    organizationId: String(params.organizationId),
    pageNumber: "1",
    count: String(params.count ?? 100),
    order: "asc",
    beginDate: String(params.beginDate),
    endDate: String(params.endDate),
  });
  if (!res.ok) return res;
  const shifts = arr((res.data as Record<string, unknown> | null)?.closedShifts);
  const summary: AstralClosedShiftsSummary = { shiftCount: shifts.length, checkCount: 0, sumKopeks: 0, cashKopeks: 0, ecashKopeks: 0 };
  for (const s of shifts) {
    summary.checkCount += toInt(s.checkCount);
    summary.sumKopeks += toInt(s.sum);
    summary.cashKopeks += toInt(s.cash);
    summary.ecashKopeks += toInt(s.ecash);
  }
  return { ok: true, data: summary };
}

// ---- analytics (analytics.aliases) — control totals --------------------------

export type AstralAnalyticsSummary = {
  profitKopeks: number;
  cashKopeks: number;
  ecashKopeks: number;
  refundsKopeks: number;
  averageKopeks: number;
};

/** Header control totals for a range (profit/cash/ecash/refunds). Reconciliation only —
 * NEVER the source of receipts. analytics.aliases requires a COMPARISON period
 * (lastBeginDate/lastEndDate); omitting it returns HTTP 406. The comparison period is
 * the immediately-preceding window of the SAME length. */
export async function fetchAnalyticsSummary(
  client: AstralClient,
  params: { organizationId: string; beginDate: number; endDate: number; type?: "profit" | "receipts" },
): Promise<AstralResult<AstralAnalyticsSummary>> {
  const length = Math.max(1, params.endDate - params.beginDate); // half-open window length in seconds
  const lastEndDate = params.beginDate; // previous period ends where this one begins
  const lastBeginDate = params.beginDate - length; // same-length preceding window
  const res = await client.call<Record<string, unknown>>("analytics.aliases", {
    organizationId: String(params.organizationId),
    beginDate: String(params.beginDate),
    endDate: String(params.endDate),
    lastBeginDate: String(lastBeginDate),
    lastEndDate: String(lastEndDate),
    page: "1",
    count: "100",
    type: params.type ?? "profit",
    allaliases: "true",
    allkkts: "true",
  });
  if (!res.ok) return res;
  const header = ((res.data as Record<string, unknown> | null)?.header ?? {}) as Record<string, unknown>;
  const val = (k: string): number => toInt((header[k] as Record<string, unknown> | undefined)?.value);
  return { ok: true, data: { profitKopeks: val("profit"), cashKopeks: val("cash"), ecashKopeks: val("ecash"), refundsKopeks: val("refunds"), averageKopeks: val("average") } };
}
