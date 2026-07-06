// Centralized, normalized view of an expense's attachments (Part 3). Returns the
// LEGACY single document (originalFileStorageKey…) AND the new ExpenseDocument
// rows together, so pages never re-implement compatibility logic. Server-only.
import { prisma } from "@/lib/prisma";
import { canPreviewInline } from "@/lib/expense-document-storage";

export const DOCUMENT_TYPES = ["receipt", "payment_confirmation", "other"] as const;
export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  receipt: "Чек",
  payment_confirmation: "Подтверждение оплаты",
  other: "Другое",
};

// Simplified (v2) statuses in which a manager may add/remove documents. After
// accounting verification (or cancellation) documents are immutable.
export const EXPENSE_DOC_EDITABLE_STATUSES = ["draft", "needs_correction"] as const;

export function isExpenseDocumentsEditable(expense: { entryVersion: number; status: string }): boolean {
  return expense.entryVersion === 2 && (EXPENSE_DOC_EDITABLE_STATUSES as readonly string[]).includes(expense.status);
}

export type LegacyAttachment = {
  kind: "legacy";
  filename: string;
  mime: string | null;
  previewHref: string;
  downloadHref: string;
  canPreview: boolean;
};

export type DocumentAttachment = {
  kind: "document";
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  documentType: string;
  documentTypeLabel: string;
  createdAt: Date;
  uploadedByUserId: string | null;
  previewHref: string;
  downloadHref: string;
  canPreview: boolean;
};

export type ExpenseAttachments = {
  legacy: LegacyAttachment | null;
  documents: DocumentAttachment[];
  activeCount: number; // legacy(0/1) + active documents — the "required minimum" basis
};

/** Active (non-removed) ExpenseDocument count for an expense. */
export async function activeDocumentCount(expenseId: string): Promise<number> {
  return prisma.expenseDocument.count({ where: { expenseId, removedAt: null } });
}

/**
 * Normalized attachments for one expense. Safe against missing optional legacy
 * metadata. Only ACTIVE documents are returned in the ordinary view.
 */
export async function getExpenseAttachments(expense: {
  id: string;
  originalFileStorageKey: string | null;
  originalFileName: string | null;
  originalFileMime: string | null;
}): Promise<ExpenseAttachments> {
  const base = `/api/expenses/${encodeURIComponent(expense.id)}`;
  const legacy: LegacyAttachment | null = expense.originalFileStorageKey
    ? {
        kind: "legacy",
        filename: expense.originalFileName ?? "Документ",
        mime: expense.originalFileMime,
        previewHref: `${base}/file`,
        downloadHref: `${base}/file?download=1`,
        canPreview: canPreviewInline(expense.originalFileMime ?? ""),
      }
    : null;

  const rows = await prisma.expenseDocument.findMany({
    where: { expenseId: expense.id, removedAt: null },
    orderBy: { createdAt: "asc" },
  });
  const documents: DocumentAttachment[] = rows.map((r) => ({
    kind: "document",
    id: r.id,
    filename: r.safeFilename || r.originalFilename || "Документ",
    mime: r.mimeType,
    sizeBytes: r.sizeBytes,
    documentType: r.documentType,
    documentTypeLabel: DOCUMENT_TYPE_LABELS[r.documentType] ?? r.documentType,
    createdAt: r.createdAt,
    uploadedByUserId: r.uploadedByUserId,
    previewHref: `${base}/documents/${encodeURIComponent(r.id)}`,
    downloadHref: `${base}/documents/${encodeURIComponent(r.id)}?download=1`,
    canPreview: canPreviewInline(r.mimeType),
  }));

  return { legacy, documents, activeCount: (legacy ? 1 : 0) + documents.length };
}
