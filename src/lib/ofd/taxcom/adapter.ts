// Pure normalization of Taxcom DocumentList summaries → NormalizedOfdReceipt.
// No I/O, no logging, fully testable. Only Income / IncomeReturn are kept; every
// other document type (expense, correction, …) is skipped in the MVP.
import type { NewDocumentsShape, NormalizedOfdReceipt, OfdOperationType, TaxcomDocumentSummary, TaxcomReceiptItem } from "@/lib/ofd/types";
import { cleanItemName, normalizeItemName } from "@/lib/ofd/revenue";

/** Map a Taxcom accountingType string to our enum, or null to SKIP the doc.
 * Only приход / возврат прихода are sales; expense / correction are skipped. */
export function mapOperationType(raw: string | null | undefined): OfdOperationType | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "income" || s === "приход") return "income";
  if (s === "incomereturn" || s === "income_return" || s === "return" || s === "возврат прихода") return "income_return";
  return null; // expense / expenseReturn / correction / none / unknown → skipped
}

/** Taxcom ФФД documentType: "2" opening shift, "5" closing shift and other
 * non-receipt service docs are NOT sales — skipped (never an import error). Only
 * "3" (receipt) can carry a sale; when documentType is absent we fall back to the
 * accountingType mapping alone. */
export function isServiceDocumentType(documentType: string | null | undefined): boolean {
  const t = String(documentType ?? "").trim();
  return t === "2" || t === "5";
}

/** Stable dedupe key. Prefer the fiscal sign (ФПД); fall back to fn+fd. */
export function buildDedupeKey(fnNumber: string, fiscalDocumentNumber: number, fiscalSign: string | null | undefined): string {
  const fpd = fiscalSign && String(fiscalSign).trim() ? String(fiscalSign).trim() : null;
  return fpd
    ? `taxcom:${fnNumber}:${fiscalDocumentNumber}:${fpd}`
    : `taxcom:${fnNumber}:${fiscalDocumentNumber}`;
}

function intKopeks(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function numOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function firstArray(o: Record<string, unknown>, keys: string[]): { present: boolean; arr: unknown[] } {
  for (const k of keys) {
    if (Array.isArray(o[k])) return { present: true, arr: o[k] as unknown[] };
  }
  return { present: false, arr: [] };
}

const ITEM_KEYS = ["items", "Items", "positions", "Positions", "goods", "Goods", "products", "Products", "services", "Services", "rows", "Rows"];

/**
 * Parse the SAFE nomenclature lines of one raw receipt document, if present.
 * Reads name/quantity/price/sum from common casings; stores only those safe fields
 * (no raw payload, no purchaser personal data). Skips a line with an empty name or
 * a non-positive sum (service lines). Returns { itemsPresent } so the caller can
 * distinguish "no positions array in the response" from "array present but empty".
 */
export function parseReceiptItems(raw: unknown): { items: TaxcomReceiptItem[]; itemsPresent: boolean } {
  const o = (raw as Record<string, unknown>) ?? {};
  const { present, arr } = firstArray(o, ITEM_KEYS);
  const items: TaxcomReceiptItem[] = [];
  for (const it of arr) {
    const io = (it as Record<string, unknown>) ?? {};
    const name = cleanItemName(
      (io.name ?? io.Name ?? io.itemName ?? io.ItemName ?? io.nomenclature ?? io.Nomenclature ?? io.productName ?? io.ProductName) as string,
    );
    if (!name) continue; // empty name → skip
    const totalKopeks = intKopeks(io.sum ?? io.Sum ?? io.total ?? io.Total ?? io.amount ?? io.Amount);
    const priceKopeks = intKopeks(io.price ?? io.Price ?? io.priceKopeks);
    if (totalKopeks <= 0) continue; // service line with sum <= 0 → skip
    const quantityMilli = Math.max(0, Math.round(numOr(io.quantity ?? io.Quantity ?? io.qty ?? io.Qty, 1) * 1000));
    items.push({ name, normalizedName: normalizeItemName(name), quantityMilli, priceKopeks, totalKopeks });
  }
  return { items, itemsPresent: present };
}

// Item-like array paths probed by the NewDocuments shape diagnostic — direct keys
// plus common nested containers. Nested paths use "parent.child".
const ITEM_LIKE_PATHS = [
  "items", "Items", "positions", "Positions", "goods", "Goods", "products", "Products", "services", "Services", "rows", "Rows",
  "fiscalData.items", "document.items", "receipt.items",
];

function arrayAtPath(o: Record<string, unknown>, path: string): unknown[] | null {
  const parts = path.split(".");
  let cur: unknown = o;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return Array.isArray(cur) ? cur : null;
}

/**
 * Inspect a raw GET /API/v2/NewDocuments response and return ONLY its SAFE shape —
 * key names + counts, never any value, raw JSON, ФПД or personal data. Detects
 * whether the response carries receipt nomenclature (item-like arrays). Never throws.
 */
export function inspectNewDocumentsShape(raw: unknown): NewDocumentsShape {
  const o = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  const topLevelKeys = Object.keys(o).sort();
  const { arr } = firstArray(o, ["records", "Records", "Items", "items", "Documents", "documents", "NewDocuments", "DocumentList"]);
  const documents = arr as Record<string, unknown>[];
  const first = documents[0] && typeof documents[0] === "object" ? documents[0] : {};
  const firstDocumentKeys = Object.keys(first).sort();

  const detectedItemLikeKeys: string[] = [];
  for (const path of ITEM_LIKE_PATHS) {
    if (arrayAtPath(first, path)) detectedItemLikeKeys.push(path);
  }

  // Safe counts by documentType value ("2" | "3" | "5" | …) — a fiscal type code,
  // not personal data.
  const documentTypeCounts: Record<string, number> = {};
  for (const d of documents) {
    const dt = d && typeof d === "object" ? (d.documentType ?? d.DocumentType ?? d.type ?? d.Type) : undefined;
    const key = dt == null || String(dt).trim() === "" ? "unknown" : String(dt).trim().slice(0, 16);
    documentTypeCounts[key] = (documentTypeCounts[key] ?? 0) + 1;
  }

  return {
    topLevelKeys,
    documentCount: documents.length,
    firstDocumentKeys,
    detectedItemLikeKeys,
    hasItemsLikeData: detectedItemLikeKeys.length > 0,
    documentTypeCounts,
  };
}

/** Why a document was not turned into a receipt (for safe aggregate diagnostics). */
export type DocSkipReason = "service" | "unsupported" | "invalid";
export type DocClassification =
  | { kind: "receipt"; receipt: NormalizedOfdReceipt }
  | { kind: "skip"; reason: DocSkipReason };

/**
 * Classify one summary into a receipt or a typed skip. Never throws.
 * - service:     shift open/close (documentType 2/5) — not a sale.
 * - unsupported: accountingType is not приход / возврат прихода.
 * - invalid:     receipt-like but unparseable date / missing fn / non-positive fd.
 */
export function classifyDocument(doc: TaxcomDocumentSummary): DocClassification {
  if (isServiceDocumentType(doc.documentType)) return { kind: "skip", reason: "service" };
  const operationType = mapOperationType(doc.operationType);
  if (!operationType) return { kind: "skip", reason: "unsupported" };
  const receiptDate = new Date(doc.dateTime);
  if (Number.isNaN(receiptDate.getTime())) return { kind: "skip", reason: "invalid" };
  if (!doc.fn || !Number.isFinite(doc.fd) || Math.trunc(doc.fd) <= 0) return { kind: "skip", reason: "invalid" };

  return {
    kind: "receipt",
    receipt: {
      fnNumber: String(doc.fn),
      shiftNumber: Number.isFinite(doc.shift) ? Math.trunc(doc.shift) : null,
      fiscalDocumentNumber: Math.trunc(doc.fd),
      fiscalSign: doc.fpd && String(doc.fpd).trim() ? String(doc.fpd).trim() : null,
      operationType,
      receiptDate,
      totalKopeks: intKopeks(doc.totalKopeks),
      cashKopeks: intKopeks(doc.cashKopeks),
      electronicKopeks: intKopeks(doc.electronicKopeks),
      dedupeKey: buildDedupeKey(String(doc.fn), Math.trunc(doc.fd), doc.fpd),
      items: doc.items ?? [],
      itemsPresent: doc.itemsPresent ?? false,
    },
  };
}

/**
 * Normalize one summary. Returns null when the doc must be skipped (service /
 * unsupported / invalid). Never throws.
 */
export function normalizeDocument(doc: TaxcomDocumentSummary): NormalizedOfdReceipt | null {
  const c = classifyDocument(doc);
  return c.kind === "receipt" ? c.receipt : null;
}

/** Aggregate skip counters — SAFE (counts only, never any document content). */
export type NormalizeStats = {
  receipts: NormalizedOfdReceipt[];
  documentCount: number;
  serviceSkipped: number;
  unsupportedSkipped: number;
  invalidSkipped: number;
};

/** Normalize a whole DocumentList, returning receipts + safe skip aggregates. */
export function normalizeDocumentsWithStats(docs: TaxcomDocumentSummary[]): NormalizeStats {
  const receipts: NormalizedOfdReceipt[] = [];
  let serviceSkipped = 0, unsupportedSkipped = 0, invalidSkipped = 0;
  for (const d of docs) {
    const c = classifyDocument(d);
    if (c.kind === "receipt") receipts.push(c.receipt);
    else if (c.reason === "service") serviceSkipped += 1;
    else if (c.reason === "unsupported") unsupportedSkipped += 1;
    else invalidSkipped += 1;
  }
  return { receipts, documentCount: docs.length, serviceSkipped, unsupportedSkipped, invalidSkipped };
}

/** Normalize a whole DocumentList, dropping skipped docs. */
export function normalizeDocuments(docs: TaxcomDocumentSummary[]): NormalizedOfdReceipt[] {
  return normalizeDocumentsWithStats(docs).receipts;
}
