// Normalizers for Astral.ОФД catalog objects (organizations, outlets/aliases, KKTs).
// Field names are taken verbatim from «Документация Астрал ОФД API.pdf» response
// samples. Everything is tolerant (string|number|boolean) because the PDF shows the
// same field both ways across responses. NO api_key / secrets ever appear here.
import { toStr, toStrOrNull, toCount, toBool } from "@/lib/ofd/astral/client";

// ---- organization.list -------------------------------------------------------

export type AstralOrganization = {
  externalOrganizationId: string; // "id"
  inn: string | null;
  kpp: string | null;
  shortTitle: string | null;
  fullTitle: string | null;
  guid: string | null;
  statusContract: string | null; // "1" = active contract (confirm on live)
  fnsStatus: string | null;
  removed: boolean;
};

export function normalizeOrganization(raw: Record<string, unknown>): AstralOrganization {
  return {
    externalOrganizationId: toStr(raw.id),
    inn: toStrOrNull(raw.inn),
    kpp: toStrOrNull(raw.kpp),
    shortTitle: toStrOrNull(raw.shortTitle ?? raw.short_title),
    fullTitle: toStrOrNull(raw.fullTitle ?? raw.full_title),
    guid: toStrOrNull(raw.guid),
    statusContract: toStrOrNull(raw.statusContract),
    fnsStatus: toStrOrNull(raw.fnsStatus),
    removed: raw.removed != null && toStr(raw.removed) !== "",
  };
}

// ---- kkt.aliasList (торговые точки / outlets) --------------------------------

export type AstralOutlet = {
  externalAliasId: string; // "id"
  alias: string | null;
  externalOrganizationId: string | null; // "organization_id"
  kktRegIds: string[]; // "a|b|" → ["a","b"]
  totalCount: number; // KKTs at this outlet
  activeCount: number;
  blockedCount: number;
  closedShiftsCount: number;
  removed: boolean;
  address: string | null;
};

/** kktRegIds arrives as a pipe-separated string "0000..|8891..|" (trailing pipe). */
export function splitKktRegIds(v: unknown): string[] {
  return toStr(v)
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function joinAddress(raw: Record<string, unknown>): string | null {
  const parts = [raw.city, raw.street, raw.house, raw.building, raw.apartment]
    .map((p) => toStr(p).trim())
    .filter((p) => p !== "");
  return parts.length ? parts.join(", ") : null;
}

export function normalizeOutlet(raw: Record<string, unknown>): AstralOutlet {
  return {
    externalAliasId: toStr(raw.id),
    alias: toStrOrNull(raw.alias),
    externalOrganizationId: toStrOrNull(raw.organization_id),
    kktRegIds: splitKktRegIds(raw.kktRegIds),
    totalCount: toCount(raw.totalCount),
    activeCount: toCount(raw.activeCount),
    blockedCount: toCount(raw.blockedCount),
    closedShiftsCount: toCount(raw.closedShiftsCount),
    removed: raw.removed != null && toStr(raw.removed) !== "",
    address: joinAddress(raw),
  };
}

// ---- kkt.search / kkt.listByAlias / kkt.getById ------------------------------

export type AstralKkt = {
  externalKktId: string; // "id"
  kktRegId: string | null; // "kktRegID"
  numberKKT: string | null; // "numberKKT"
  factoryFiscalDrive: string | null; // "factoryFiscalDrive" (ФН заводской № → fnNumber)
  nameModelKKT: string | null;
  externalAliasId: string | null; // "kktAliasId"
  alias: string | null;
  status: string | null;
  statusOfd: string | null; // "connected" | ...
  removed: boolean;
  shiftActive: boolean;
  lastUpdate: string | null;
  endFiscalDrive: string | null; // unix seconds (string)
  endPin: string | null;
};

export function normalizeKkt(raw: Record<string, unknown>): AstralKkt {
  return {
    externalKktId: toStr(raw.id),
    kktRegId: toStrOrNull(raw.kktRegID ?? raw.kktRegId),
    numberKKT: toStrOrNull(raw.numberKKT),
    factoryFiscalDrive: toStrOrNull(raw.factoryFiscalDrive),
    nameModelKKT: toStrOrNull(raw.nameModelKKT),
    externalAliasId: toStrOrNull(raw.kktAliasId ?? raw.aliasId),
    alias: toStrOrNull(raw.alias),
    status: toStrOrNull(raw.status),
    statusOfd: toStrOrNull(raw.statusOfd),
    removed: raw.removed != null && toStr(raw.removed) !== "",
    shiftActive: toBool(raw.shiftActive),
    lastUpdate: toStrOrNull(raw.lastUpdate),
    endFiscalDrive: toStrOrNull(raw.endFiscalDrive),
    endPin: toStrOrNull(raw.endPin),
  };
}

/** The ФН number CLUB-OPS keys receipts by (OfdCashRegisterMapping.fnNumber and the
 * receipt dedupeKey). Astral's fiscalDriveNumber on a receipt equals the KKT's
 * factoryFiscalDrive, so that is the canonical mapping key. */
export function kktFnNumber(kkt: AstralKkt): string {
  return kkt.factoryFiscalDrive ?? "";
}
