// Duplicate detection for invoice entry (§11). Pure classifier + a company-scoped DB lookup.
// Levels: A exact (same file hash OR EDO id) → block; B probable (same supplier INN + number
// + date + total) → show the existing invoice, require an explicit confirm; C weak (some
// fields match) → warning only. Every override is audited by the caller. Integer kopeks.
import { prisma } from "@/lib/prisma";

export type DuplicateLevel = "exact" | "probable" | "weak" | "none";

export type InvoiceFingerprint = {
  counterpartyInn?: string | null;
  invoiceNumber?: string | null;
  invoiceDateIso?: string | null; // "YYYY-MM-DD"
  amountKopeks?: number | null;
  fileHash?: string | null;
  edoDocumentId?: string | null;
};

const dg = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const nk = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, "").trim();

/** Compare a candidate against ONE existing invoice fingerprint. */
export function classifyDuplicatePair(a: InvoiceFingerprint, b: InvoiceFingerprint): DuplicateLevel {
  // A — exact: identical file hash or identical EDO document id.
  if (a.fileHash && b.fileHash && a.fileHash === b.fileHash) return "exact";
  if (a.edoDocumentId && b.edoDocumentId && nk(a.edoDocumentId) === nk(b.edoDocumentId)) return "exact";
  // B — probable: same supplier INN + number + date + total.
  const innEq = dg(a.counterpartyInn) && dg(a.counterpartyInn) === dg(b.counterpartyInn);
  const numEq = nk(a.invoiceNumber) && nk(a.invoiceNumber) === nk(b.invoiceNumber);
  const dateEq = a.invoiceDateIso && a.invoiceDateIso === b.invoiceDateIso;
  const amtEq = a.amountKopeks != null && a.amountKopeks === b.amountKopeks;
  if (innEq && numEq && dateEq && amtEq) return "probable";
  // C — weak: at least two of {INN, number, amount} match.
  const weak = [innEq, numEq, amtEq].filter(Boolean).length;
  if (weak >= 2) return "weak";
  return "none";
}

export type DuplicateHit = { invoiceId: string; level: DuplicateLevel; number: string | null; amountKopeks: number; status: string };

/**
 * Find existing invoices in the SAME company that duplicate a candidate. Never crosses
 * company scope. Returns the strongest level per matching invoice, strongest first.
 */
export async function findInvoiceDuplicates(companyId: string, cand: InvoiceFingerprint): Promise<DuplicateHit[]> {
  const existing = await prisma.invoice.findMany({
    where: {
      companyId,
      status: { notIn: ["canceled", "rejected"] },
      OR: [
        ...(dg(cand.counterpartyInn) ? [{ counterpartyInn: { contains: dg(cand.counterpartyInn).slice(0, 12) } as never }] : []),
        ...(cand.invoiceNumber ? [{ invoiceNumber: cand.invoiceNumber }] : []),
        ...(cand.amountKopeks != null ? [{ amountKopeks: cand.amountKopeks }] : []),
      ],
    },
    select: { id: true, counterpartyInn: true, invoiceNumber: true, invoiceDate: true, amountKopeks: true, status: true },
    take: 50,
  });
  const rank: Record<DuplicateLevel, number> = { exact: 3, probable: 2, weak: 1, none: 0 };
  const hits: DuplicateHit[] = [];
  for (const e of existing) {
    const level = classifyDuplicatePair(cand, {
      counterpartyInn: e.counterpartyInn, invoiceNumber: e.invoiceNumber,
      invoiceDateIso: e.invoiceDate ? e.invoiceDate.toISOString().slice(0, 10) : null, amountKopeks: e.amountKopeks,
    });
    if (level !== "none") hits.push({ invoiceId: e.id, level, number: e.invoiceNumber, amountKopeks: e.amountKopeks, status: e.status });
  }
  return hits.sort((x, y) => rank[y.level] - rank[x.level]);
}
