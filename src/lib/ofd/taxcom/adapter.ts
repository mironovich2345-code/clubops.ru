// Pure normalization of Taxcom DocumentList summaries → NormalizedOfdReceipt.
// No I/O, no logging, fully testable. Only Income / IncomeReturn are kept; every
// other document type (expense, correction, …) is skipped in the MVP.
import type { NormalizedOfdReceipt, OfdOperationType, TaxcomDocumentSummary } from "@/lib/ofd/types";

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

/**
 * Normalize one summary. Returns null when the doc must be skipped (non-income
 * type or an unparseable date). Never throws.
 */
export function normalizeDocument(doc: TaxcomDocumentSummary): NormalizedOfdReceipt | null {
  // Skip shift open/close and other service documents (documentType 2/5). Not an
  // error — an empty/service-only shift simply yields no receipts.
  if (isServiceDocumentType(doc.documentType)) return null;
  const operationType = mapOperationType(doc.operationType);
  if (!operationType) return null; // no приход/возврат прихода mapping → skip
  const receiptDate = new Date(doc.dateTime);
  if (Number.isNaN(receiptDate.getTime())) return null;
  if (!doc.fn || !Number.isFinite(doc.fd) || Math.trunc(doc.fd) <= 0) return null;

  return {
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
  };
}

/** Normalize a whole DocumentList, dropping skipped docs. */
export function normalizeDocuments(docs: TaxcomDocumentSummary[]): NormalizedOfdReceipt[] {
  const out: NormalizedOfdReceipt[] = [];
  for (const d of docs) {
    const n = normalizeDocument(d);
    if (n) out.push(n);
  }
  return out;
}
