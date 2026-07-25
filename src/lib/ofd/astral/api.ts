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

/** One page of POST /documents.tickets. Returns the RAW document objects (the caller
 * normalizes) + totalCount (string|number → number). Sends only the fields the
 * production sync needs (project rule §8 — no superfluous filters). */
export async function fetchReceiptsPage(
  client: AstralClient,
  params: FetchReceiptsPageParams,
): Promise<AstralResult<{ documents: Record<string, unknown>[]; totalCount: number }>> {
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
