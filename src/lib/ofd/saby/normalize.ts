// Saby ОФД → shared NormalizedOfdReceipt mapping (pure). Structure is defined against the
// FFD fiscal-document model; the EXACT Saby JSON key names must be verified on a real cabinet
// (docs/audits/ofd-saby-integration-audit.md) — so this reads well-known keys with safe
// fallbacks and NEVER invents money out of missing fields. Reuses the shared provider dedupe
// key so a Saby receipt that also arrived via Taxcom/Astral is de-duplicated by fiscal
// fingerprint downstream. No DB.
import type { NormalizedOfdReceipt } from "@/lib/ofd/types";
import { buildProviderDedupeKey } from "@/lib/ofd/providers/types";

export const SABY_PROVIDER_ID = "saby";

const toStr = (v: unknown): string | null => (v == null ? null : String(v).trim() || null);
const toInt = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const rublesToKopeks = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const first = (obj: Record<string, unknown>, keys: string[]): unknown => { for (const k of keys) if (obj[k] != null) return obj[k]; return undefined; };

/** Map a Saby document `operationType`/type to the shared income | income_return, or null for
 * non-revenue (correction / service / expense) — those are counted as diagnostics, not booked
 * (mirrors Astral/Taxcom project rule). */
export function sabyOperationType(raw: Record<string, unknown>): "income" | "income_return" | null {
  const t = String(first(raw, ["operationType", "receiptType", "documentType", "type", "calculationType"]) ?? "").toLowerCase();
  if (/return|refund|возврат/.test(t)) return "income_return";
  if (/sale|income|приход|чек|receipt/.test(t)) return "income";
  // Numeric FFD calculation type: 1 = приход, 2 = возврат прихода.
  if (t === "1") return "income";
  if (t === "2") return "income_return";
  return null; // correction / расход / unknown → not booked
}

/**
 * Normalize one Saby fiscal document (already parsed JSON) to the shared receipt DTO. Returns
 * null for non-revenue documents. `operatorName` is captured when Saby returns the cashier
 * (FFD tag 1021) value; otherwise null → the receipt attributes as unmatched (never guessed).
 */
export function normalizeSabyDoc(raw: Record<string, unknown>): NormalizedOfdReceipt | null {
  const operationType = sabyOperationType(raw);
  if (operationType == null) return null;

  const fnNumber = toStr(first(raw, ["fiscalDriveNumber", "fnNumber", "fn", "storageId"])) ?? "";
  const fiscalDocumentNumber = toInt(first(raw, ["fiscalDocumentNumber", "docNum", "fdNumber", "fd"]));
  const fiscalSign = toStr(first(raw, ["fiscalSign", "fpd", "fp"]));
  const dateRaw = first(raw, ["receiptDateTime", "docDate", "dateTime", "date"]);
  const receiptDate = dateRaw ? new Date(String(dateRaw)) : new Date(NaN);
  const totalKopeks = rublesToKopeks(first(raw, ["totalSum", "total", "sum", "amount"]));
  const cashKopeks = rublesToKopeks(first(raw, ["cashSum", "cash"]));
  const electronicKopeks = rublesToKopeks(first(raw, ["ecashSum", "electronic", "card"]));
  const operatorName = toStr(first(raw, ["operator", "cashier", "operatorName"]));
  const externalCashierId = toStr(first(raw, ["operatorInn", "cashierInn"]));

  if (!fnNumber || !fiscalDocumentNumber || Number.isNaN(receiptDate.getTime())) return null; // incomplete fiscal id → skip, do not fabricate

  return {
    fnNumber,
    shiftNumber: (() => { const s = first(raw, ["shiftNumber", "shift"]); return s != null ? toInt(s) : null; })(),
    fiscalDocumentNumber,
    fiscalSign,
    operationType,
    receiptDate,
    totalKopeks,
    cashKopeks,
    electronicKopeks,
    dedupeKey: buildProviderDedupeKey(SABY_PROVIDER_ID, fnNumber, fiscalDocumentNumber, fiscalSign),
    operatorName,
    externalCashierId,
  };
}
