// Astral.ОФД fiscal-document normalization (documents.tickets / documents.shiftTickets).
// Field names are taken verbatim from «Документация Астрал ОФД API.pdf». Every amount
// is ALREADY in kopeks (sum/cash/ecash/credit/prepaid/provision) — NEVER multiply by
// 100. Output feeds the SHARED NormalizedOfdReceipt so ALL downstream aggregation
// (importer → OfdReceiptImport → items → categories → daily summaries → dashboard →
// «Фактические деньги») is reused unchanged.
import type { NormalizedOfdReceipt, OfdOperationType, TaxcomReceiptItem } from "@/lib/ofd/types";
import { buildProviderDedupeKey } from "@/lib/ofd/providers/types";
import { ASTRAL_PROVIDER_ID } from "@/lib/ofd/providers/astral-provider";
import { toInt, toNum, toStr, toStrOrNull } from "@/lib/ofd/astral/client";

// ---- document classification -------------------------------------------------
//
// PROVISIONAL. The PDF enumerates the allowed documentType values
// ("1","2","3","4","5","6","11","21","31","41") but gives NO explicit meaning table,
// so the mapping below uses the standard ФФД (54-ФЗ) form codes and MUST be confirmed
// against one real test day before mass import (project rule #12):
//   1  Отчёт о регистрации              — service
//   2  Отчёт об открытии смены          — service
//   3  Кассовый чек                     — SALE-bearing (operationType decides приход/возврат)
//   4  Бланк строгой отчётности (БСО)   — SALE-bearing
//   5  Отчёт о закрытии смены           — service
//   6  Отчёт о закрытии ФН              — service
//   11 Отчёт о текущем состоянии расчётов — service
//   21 Кассовый чек коррекции          — SALE-bearing (correction)
//   31 БСО коррекции                    — SALE-bearing (correction)
//   41 Отчёт о перерегистрации          — service
//
// operationType (ФФД tag 1054) in RESPONSES is numeric:
//   1 Приход, 2 Возврат прихода, 3 Расход, 4 Возврат расхода. 0 = no operation (service).
export const ASTRAL_SALE_DOCUMENT_TYPES = new Set(["3", "4", "21", "31"]);
export const ASTRAL_SERVICE_DOCUMENT_TYPES = new Set(["1", "2", "5", "6", "11", "41"]);

// operationTypes REQUEST values are Cyrillic strings (PDF §documents.tickets). The
// production sync narrows to sales + sale-returns; the response operationType is numeric.
export const ASTRAL_OP_INCOME = "Приход";
export const ASTRAL_OP_INCOME_RETURN = "Возврат прихода";
export const ASTRAL_SALES_OPERATION_TYPES = [ASTRAL_OP_INCOME, ASTRAL_OP_INCOME_RETURN];

// OFD business timezone. Europe/Moscow is a FIXED UTC+3 (no DST since 2014), so a
// constant offset is exact year-round. If a club ever uses a DST timezone this is the
// single place to switch to a real tz library — the boundaries below are computed from
// the offset, so daylight transitions would be handled there, not at call sites.
export const CLUB_TZ_OFFSET = "+03:00";

/** Add `days` calendar days to a YYYY-MM-DD, rolling months/years correctly (UTC math,
 * date-only — no timezone drift). */
export function addDaysYmd(ymd: string, days: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export type ClubDayRange = { beginDate: number; endDate: number; beginIso: string; endIso: string };

/**
 * Convert an inclusive [dateFrom, dateTo] business-day range to a unix-seconds window
 * for documents.tickets. The window is a HALF-OPEN interval in the club timezone:
 *   begin        = dateFrom 00:00:00
 *   endExclusive = (dateTo + 1 day) 00:00:00   ← never equals begin
 * so a single day (dateFrom == dateTo) still spans a full calendar day and beginDate is
 * never equal to endDate. Month/year rollovers are handled by addDaysYmd. Returns ISO
 * strings too for safe diagnostic tracing.
 */
export function clubDayRangeUnix(dateFrom: string, dateTo: string, tzOffset: string = CLUB_TZ_OFFSET): ClubDayRange {
  const begin = Date.parse(`${dateFrom}T00:00:00${tzOffset}`);
  const endExclusive = Date.parse(`${addDaysYmd(dateTo, 1)}T00:00:00${tzOffset}`);
  return {
    beginDate: Math.floor(begin / 1000),
    endDate: Math.floor(endExclusive / 1000),
    beginIso: new Date(begin).toISOString(),
    endIso: new Date(endExclusive).toISOString(),
  };
}

/** Back-compat wrapper (unix bounds only). Uses the half-open [begin, endExclusive). */
export function moscowDayRangeUnix(dateFrom: string, dateTo: string): { beginDate: number; endDate: number } {
  const r = clubDayRangeUnix(dateFrom, dateTo);
  return { beginDate: r.beginDate, endDate: r.endDate };
}

export type AstralDocClass = "sale" | "sale_return" | "expense" | "expense_return" | "service_document" | "unknown";

/** Classify by (documentType, operationType). Safe fallback: an unrecognized combo
 * is "unknown" (never counted as revenue), not silently treated as a sale. */
export function classifyAstralDocument(documentType: string | null, operationType: number | null): AstralDocClass {
  const dt = documentType ?? "";
  const op = operationType;
  // Expense / expense-return are recognized regardless of document form.
  if (op === 3) return "expense";
  if (op === 4) return "expense_return";
  if (ASTRAL_SERVICE_DOCUMENT_TYPES.has(dt)) return "service_document";
  if (ASTRAL_SALE_DOCUMENT_TYPES.has(dt)) {
    if (op === 1) return "sale";
    if (op === 2) return "sale_return";
    // A sale-form document with operationType 0/unknown → not a confirmed sale.
    return "service_document";
  }
  return "unknown";
}

/** Only приход/возврат прихода carry into the shared income model. */
export function docClassToOperation(cls: AstralDocClass): OfdOperationType | null {
  if (cls === "sale") return "income";
  if (cls === "sale_return") return "income_return";
  return null; // expense / expense_return / service / unknown are NOT revenue
}

// ---- raw ticket shape (from PDF) ---------------------------------------------

export type AstralRawTicket = {
  fiscalDriveNumber?: string;
  kktRegId?: string;
  checkNumber?: number | string;
  fiscalDocumentNumber?: number | string;
  fiscalSign?: number | string;
  documentType?: string | number;
  operationType?: number | string;
  shiftNumber?: number | string;
  inn?: string;
  issueDate?: number | string; // unix seconds
  ofdTime?: number | string; // unix seconds
  fnsSendDate?: number | string; // unix seconds
  taxationType?: number | string;
  operator?: string;
  cashier?: string;
  version?: string;
  // amounts — ALREADY kopeks
  sum?: number | string;
  cash?: number | string;
  ecash?: number | string;
  credit?: number | string;
  prepaid?: number | string;
  provision?: number | string;
  paytype?: string;
  items?: Array<{ name?: string; count?: number | string; quantity?: number | string; price?: number | string; sum?: number | string; nds?: unknown; paymentType?: unknown; paymentSubject?: unknown }>;
  [k: string]: unknown;
};

export type AstralPaymentBreakdown = { cash: number; ecash: number; credit: number; prepaid: number; provision: number };

export type AstralNormalizedDoc = {
  docClass: AstralDocClass;
  isRevenue: boolean;
  rawDocumentType: string | null;
  rawOperationType: string | null;
  fnNumber: string;
  kktRegId: string | null;
  fiscalDocumentNumber: number;
  fiscalSign: string | null;
  shiftNumber: number | null;
  inn: string | null;
  receiptDate: Date;
  ofdTime: Date | null;
  fnsSendDate: Date | null;
  taxationType: string | null;
  cashier: string | null;
  version: string | null;
  totalKopeks: number;
  cashKopeks: number;
  electronicKopeks: number;
  payments: AstralPaymentBreakdown;
  /** cash+ecash+credit+prepaid+provision !== sum → flagged (import still proceeds). */
  paymentMismatch: boolean;
  operationType: OfdOperationType | null;
  items?: TaxcomReceiptItem[];
  itemsPresent?: boolean;
  dedupeKey: string;
};

const unixToDate = (v: unknown): Date | null => {
  const n = toNum(v, NaN);
  return Number.isFinite(n) && n > 0 ? new Date(Math.round(n) * 1000) : null;
};

/** Normalize the nomenclature. Per §14: keep only what's actually present; if price/sum
 * are absent, keep name + quantity and DO NOT fabricate amounts (0 kopeks). */
export function normalizeAstralItems(raw: AstralRawTicket): TaxcomReceiptItem[] | undefined {
  if (!Array.isArray(raw.items) || raw.items.length === 0) return undefined;
  return raw.items.map((it) => {
    const name = toStr(it.name).slice(0, 256);
    const qtyRaw = it.count ?? it.quantity;
    const quantityMilli = Math.max(0, Math.round(toNum(qtyRaw, 1) * 1000)) || 1000;
    const priceKopeks = it.price != null ? toInt(it.price) : 0;
    const totalKopeks = it.sum != null ? toInt(it.sum) : priceKopeks > 0 ? Math.round((priceKopeks * quantityMilli) / 1000) : 0;
    return {
      name,
      normalizedName: name.toLowerCase().replace(/\s+/g, " ").trim(),
      quantityMilli,
      priceKopeks,
      totalKopeks,
    };
  });
}

/** Map one Astral ticket to the normalized doc (classification + money + identity). */
export function normalizeAstralDocument(raw: AstralRawTicket): AstralNormalizedDoc {
  const fnNumber = toStr(raw.fiscalDriveNumber);
  const documentType = toStrOrNull(raw.documentType);
  const operationTypeNum = raw.operationType != null && toStr(raw.operationType) !== "" ? toInt(raw.operationType) : null;
  const cls = classifyAstralDocument(documentType, operationTypeNum);
  const op = docClassToOperation(cls);

  // Fiscal document number: prefer explicit fiscalDocumentNumber, else checkNumber.
  // The dedupeKey ALSO includes fiscalSign (unique within an FN), so a checkNumber
  // fallback never causes a cross-FN/KKT collision (project rule #11).
  const fiscalDocumentNumber = toInt(raw.fiscalDocumentNumber ?? raw.checkNumber);
  const fiscalSign = toStrOrNull(raw.fiscalSign);

  const payments: AstralPaymentBreakdown = {
    cash: toInt(raw.cash),
    ecash: toInt(raw.ecash),
    credit: toInt(raw.credit),
    prepaid: toInt(raw.prepaid),
    provision: toInt(raw.provision),
  };
  const totalKopeks = toInt(raw.sum);
  const cashKopeks = payments.cash;
  const electronicKopeks = payments.ecash + payments.credit + payments.prepaid + payments.provision;
  const paymentSum = payments.cash + payments.ecash + payments.credit + payments.prepaid + payments.provision;
  const paymentMismatch = totalKopeks > 0 && paymentSum !== totalKopeks;

  const issue = unixToDate(raw.issueDate);
  const ofdTime = unixToDate(raw.ofdTime);
  const receiptDate = issue ?? ofdTime ?? new Date(0);

  const items = normalizeAstralItems(raw);

  return {
    docClass: cls,
    isRevenue: op != null,
    rawDocumentType: documentType,
    rawOperationType: operationTypeNum != null ? String(operationTypeNum) : null,
    fnNumber,
    kktRegId: toStrOrNull(raw.kktRegId),
    fiscalDocumentNumber,
    fiscalSign,
    shiftNumber: raw.shiftNumber != null && toStr(raw.shiftNumber) !== "" ? toInt(raw.shiftNumber) : null,
    inn: toStrOrNull(raw.inn),
    receiptDate,
    ofdTime,
    fnsSendDate: unixToDate(raw.fnsSendDate),
    taxationType: toStrOrNull(raw.taxationType),
    cashier: toStrOrNull(raw.operator ?? raw.cashier),
    version: toStrOrNull(raw.version),
    totalKopeks,
    cashKopeks,
    electronicKopeks,
    payments,
    paymentMismatch,
    operationType: op,
    items,
    itemsPresent: Boolean(items && items.length),
    dedupeKey: buildProviderDedupeKey(ASTRAL_PROVIDER_ID, fnNumber, fiscalDocumentNumber, fiscalSign),
  };
}

/** Project a normalized doc to the SHARED NormalizedOfdReceipt. Returns null for
 * non-revenue documents (service / expense / unknown) — the importer counts those
 * as diagnostics and never books them as revenue (project rule #12). */
export function toNormalizedReceipt(doc: AstralNormalizedDoc): NormalizedOfdReceipt | null {
  if (doc.operationType == null) return null;
  return {
    fnNumber: doc.fnNumber,
    shiftNumber: doc.shiftNumber,
    fiscalDocumentNumber: doc.fiscalDocumentNumber,
    fiscalSign: doc.fiscalSign,
    operationType: doc.operationType,
    receiptDate: doc.receiptDate,
    totalKopeks: doc.totalKopeks,
    cashKopeks: doc.cashKopeks,
    electronicKopeks: doc.electronicKopeks,
    dedupeKey: doc.dedupeKey,
    items: doc.items,
    itemsPresent: doc.itemsPresent,
    // STAGE 13: carry the operator name to persistence. No reliable per-cashier external id
    // from Astral (inn is the org's), so externalCashierId stays null.
    operatorName: doc.cashier,
    externalCashierId: null,
  };
}
