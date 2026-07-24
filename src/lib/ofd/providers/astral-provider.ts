// Astral.ОФД provider — SKELETON. Status: BLOCKED BY CREDENTIALS/DOCUMENTATION.
// No account, API key, or authenticated access to the official Astral.ОФД cabinet is
// available, so per project rule #7 this is NOT wired as live and testConnection cannot
// authorize. The provisional normalizer below maps a *reasonable* Astral receipt shape
// to the shared NormalizedOfdReceipt so the adapter architecture + downstream analytics
// are proven; the EXACT field names/units MUST be confirmed against official Astral docs
// (see docs/integrations/astral-ofd-discovery.md) before enabling.
import type { OfdConnectionConfig, NormalizedOfdReceipt, OfdOperationType, TaxcomReceiptItem } from "@/lib/ofd/types";
import type { OfdProvider, OfdTestConnectionResult } from "@/lib/ofd/providers/types";
import { buildProviderDedupeKey } from "@/lib/ofd/providers/types";

export const ASTRAL_PROVIDER_ID = "astral";
export const ASTRAL_STATUS = "blocked_by_credentials" as const;

/** PROVISIONAL raw shape (to be confirmed against official Astral.ОФД documentation). */
export type AstralRawReceipt = {
  fn?: string; fnNumber?: string;
  fd?: number | string; fiscalDocumentNumber?: number | string;
  fp?: string | number; fiscalSign?: string | number;
  shift?: number | string; shiftNumber?: number | string;
  // operation: приход / возврат прихода — string or numeric (1 income, 2 income return)
  operationType?: string | number; type?: string | number;
  dateTime?: string; receiptDate?: string; date?: string;
  // Amounts — PROVISIONAL: assumed integer kopeks (confirm units!).
  totalKopeks?: number; totalSum?: number;
  cashKopeks?: number; cashSum?: number;
  electronicKopeks?: number; ecashSum?: number; electronicSum?: number;
  items?: Array<{ name?: string; price?: number; quantity?: number; sum?: number }>;
};

const toInt = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const pick = <T>(...vals: Array<T | undefined | null>): T | undefined => vals.find((v) => v != null) ?? undefined;

/** Map an income/return operation flag to the shared union. */
function mapOperation(raw: AstralRawReceipt): OfdOperationType {
  const v = pick(raw.operationType, raw.type);
  const s = String(v ?? "").toLowerCase();
  if (s === "2" || s.includes("return") || s.includes("возврат")) return "income_return";
  return "income"; // default: приход
}

function mapItems(raw: AstralRawReceipt): TaxcomReceiptItem[] | undefined {
  if (!Array.isArray(raw.items) || raw.items.length === 0) return undefined;
  return raw.items.map((it) => {
    const name = String(it.name ?? "").slice(0, 256);
    const priceKopeks = toInt(it.price);
    const quantityMilli = Math.max(0, Math.round((typeof it.quantity === "number" ? it.quantity : 1) * 1000));
    const totalKopeks = it.sum != null ? toInt(it.sum) : Math.round((priceKopeks * quantityMilli) / 1000);
    return { name, normalizedName: name.toLowerCase().replace(/\s+/g, " ").trim(), quantityMilli, priceKopeks, totalKopeks };
  });
}

/**
 * PROVISIONAL Astral → NormalizedOfdReceipt mapper. Confirm field names/units against
 * official docs before enabling. Produces an astral-prefixed dedupeKey so it can never
 * collide with Taxcom rows.
 */
export function mapAstralReceipt(raw: AstralRawReceipt): NormalizedOfdReceipt {
  const fnNumber = String(pick(raw.fnNumber, raw.fn) ?? "");
  const fiscalDocumentNumber = toInt(pick(raw.fiscalDocumentNumber, raw.fd));
  const fiscalSignRaw = pick(raw.fiscalSign, raw.fp);
  const fiscalSign = fiscalSignRaw != null ? String(fiscalSignRaw) : null;
  const shiftRaw = pick(raw.shiftNumber, raw.shift);
  const shiftNumber = shiftRaw != null && shiftRaw !== "" ? toInt(shiftRaw) : null;
  const dateStr = pick(raw.receiptDate, raw.dateTime, raw.date) ?? "";
  const receiptDate = dateStr ? new Date(dateStr) : new Date(0);
  const totalKopeks = toInt(pick(raw.totalKopeks, raw.totalSum));
  const cashKopeks = toInt(pick(raw.cashKopeks, raw.cashSum));
  const electronicKopeks = toInt(pick(raw.electronicKopeks, raw.ecashSum, raw.electronicSum));
  const items = mapItems(raw);
  return {
    fnNumber,
    shiftNumber,
    fiscalDocumentNumber,
    fiscalSign,
    operationType: mapOperation(raw),
    receiptDate,
    totalKopeks,
    cashKopeks,
    electronicKopeks,
    dedupeKey: buildProviderDedupeKey(ASTRAL_PROVIDER_ID, fnNumber, fiscalDocumentNumber, fiscalSign),
    items,
    itemsPresent: Boolean(items && items.length),
  };
}

export const AstralProvider: OfdProvider = {
  id: ASTRAL_PROVIDER_ID,
  label: "Астрал.ОФД",
  status: "blocked_by_documentation", // no official docs / account access available yet
  async testConnection(_config: OfdConnectionConfig): Promise<OfdTestConnectionResult> {
    // Not wired: refuse rather than pretend. No live request is made without real
    // credentials + confirmed endpoints (project rule #7).
    return {
      ok: false,
      code: "ASTRAL_NOT_CONFIGURED",
      message: "Интеграция Астрал.ОФД ещё не подключена: нужны реальные реквизиты и подтверждённая документация. См. docs/integrations/astral-ofd-discovery.md.",
    };
  },
};
