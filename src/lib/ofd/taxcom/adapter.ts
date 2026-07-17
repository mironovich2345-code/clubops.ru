// Pure normalization of Taxcom DocumentList summaries → NormalizedOfdReceipt.
// No I/O, no logging, fully testable. Only Income / IncomeReturn are kept; every
// other document type (expense, correction, …) is skipped in the MVP.
import type { DocumentInfoShape, NewDocumentsShape, NormalizedOfdReceipt, OfdOperationType, TaxcomDocumentSummary, TaxcomReceiptItem } from "@/lib/ofd/types";
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

/** The Taxcom numeric ФФД "предмет расчёта" tag holding receipt positions. In JS an
 * object key is always a string, so o["1059"] and o[1059] are the same property. */
const FFD_ITEMS_TAG = "1059";

/** Extract the positions array from either a string-keyed array (items/positions/…)
 * or the numeric ФФД tag 1059 (array = many positions, object = one). */
function extractPositions(o: Record<string, unknown>): { present: boolean; arr: unknown[] } {
  const strArr = firstArray(o, ITEM_KEYS);
  if (strArr.present) return strArr;
  const ffd = o[FFD_ITEMS_TAG];
  if (Array.isArray(ffd)) return { present: true, arr: ffd };
  if (ffd && typeof ffd === "object") return { present: true, arr: [ffd] };
  return { present: false, arr: [] };
}

/**
 * Parse the SAFE nomenclature lines of one raw receipt document, if present.
 * Understands BOTH the string-key shape (items/positions/…) and Taxcom's numeric
 * ФФД shape (tag 1059 with per-position tags 1030 name / 1023 quantity / 1079 price
 * / 1043 sum). Stores only safe fields (no raw payload, no ФПД, no purchaser
 * personal data). Skips a line with an empty name or a non-positive sum. Returns
 * { itemsPresent } so the caller can distinguish "no positions" from "empty array".
 */
export function parseReceiptItems(raw: unknown): { items: TaxcomReceiptItem[]; itemsPresent: boolean } {
  const o = (raw as Record<string, unknown>) ?? {};
  const { present, arr } = extractPositions(o);
  const items: TaxcomReceiptItem[] = [];
  for (const it of arr) {
    const io = (it as Record<string, unknown>) ?? {};
    // 1030 name / 1023 quantity / 1079 price / 1043 sum, plus string-key fallbacks.
    const name = cleanItemName(io["1030"] ?? io.name ?? io.Name ?? io.itemName ?? io.ItemName ?? io.nomenclature ?? io.Nomenclature ?? io.productName ?? io.ProductName);
    if (!name) continue; // empty name → skip
    const totalKopeks = intKopeks(io["1043"] ?? io.sum ?? io.Sum ?? io.total ?? io.Total ?? io.amount ?? io.Amount);
    if (totalKopeks <= 0) continue; // service line with sum <= 0 → skip
    const priceKopeks = intKopeks(io["1079"] ?? io.price ?? io.Price ?? io.priceKopeks);
    const quantityMilli = Math.max(0, Math.round(numOr(io["1023"] ?? io.quantity ?? io.Quantity ?? io.qty ?? io.Qty, 1) * 1000));
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

// Item-like array paths probed by the DocumentInfo shape diagnostic — direct keys
// plus nested containers (adds ticket.items / content.items vs NewDocuments).
const DOC_ITEM_LIKE_PATHS = [
  "items", "Items", "positions", "Positions", "goods", "Goods", "products", "Products", "services", "Services", "rows", "Rows",
  "fiscalData.items", "document.items", "receipt.items", "ticket.items", "content.items",
];

/**
 * Inspect a raw GET /API/v2/DocumentInfo response (one fiscal document) and return
 * ONLY its SAFE shape — key names + counts, never any value, raw JSON, ФПД or
 * personal data. Detects whether the document carries receipt nomenclature. Never
 * throws.
 */
function valueAtPath(o: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = o;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function inspectDocumentInfoShape(raw: unknown): DocumentInfoShape {
  const o = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  const topLevelKeys = Object.keys(o).sort();
  // The "document" may be the response root or a nested wrapper.
  const docObj = (["document", "Document", "ticket", "Ticket", "content", "Content", "receipt", "Receipt", "fiscalData", "FiscalData"]
    .map((k) => o[k])
    .find((v) => v && typeof v === "object") ?? o) as Record<string, unknown>;
  const documentKeys = Object.keys(docObj).sort();

  const detectedItemLikeKeys: string[] = [];
  let itemLikeCount = 0;
  let firstItemKeys: string[] = [];
  const noteFirst = (v: unknown) => {
    if (firstItemKeys.length === 0 && v && typeof v === "object") firstItemKeys = Object.keys(v as Record<string, unknown>).sort();
  };
  for (const path of DOC_ITEM_LIKE_PATHS) {
    const arr = arrayAtPath(o, path);
    if (arr) { detectedItemLikeKeys.push(path); itemLikeCount += arr.length; noteFirst(arr[0]); }
  }

  // Taxcom numeric ФФД: positions live under tag 1059 (array = many, object = one).
  // Probe the document wrapper first, then the response root.
  let numericFfdModeDetected = false;
  for (const path of ["document.1059", "Document.1059", "1059"]) {
    const v = valueAtPath(o, path);
    if (v == null) continue;
    numericFfdModeDetected = true; // 1059 tag present (even if not item-like)
    if (Array.isArray(v)) {
      detectedItemLikeKeys.push(path); itemLikeCount += v.length; noteFirst(v[0]);
    } else if (typeof v === "object") {
      detectedItemLikeKeys.push(path); itemLikeCount += 1; noteFirst(v);
    }
    break; // first present 1059 wins
  }

  const dt = o.documentType ?? o.DocumentType ?? o.type ?? o.Type ?? docObj.documentType ?? docObj.DocumentType;
  const safeDocumentType = dt == null || String(dt).trim() === "" ? null : String(dt).trim().slice(0, 16);

  return { topLevelKeys, documentKeys, detectedItemLikeKeys, hasItemsLikeData: detectedItemLikeKeys.length > 0, itemLikeCount, firstItemKeys, numericFfdModeDetected, safeDocumentType };
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
