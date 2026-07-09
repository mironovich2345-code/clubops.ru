// Reusable, verify-only document-verification contract (Phase groundwork). Pure,
// no imports, NOT wired to the expense workflow. A future "verify_only" expense
// mode will COMPARE user-entered values against a document and surface issues —
// it must never fill, change, confirm, or re-status an expense. These types +
// the pure comparator exist so that later work reuses one safe contract.

export type EvidenceSource = "text" | "vision";

export type DocumentEvidence = {
  page: number | null;
  source: EvidenceSource;
  snippet: string; // short, bounded — never a long document fragment
  confidence: number; // 0..1
};

export type VerificationSeverity = "info" | "warning" | "mismatch";

export type VerificationIssue = {
  field: string;
  severity: VerificationSeverity;
  code: string;
  message: string;
  expectedValue: string | null; // what the user entered
  documentValue: string | null; // what the document appears to say
  evidence: DocumentEvidence | null;
};

/** Bound a snippet so evidence never carries long document content. */
export function boundSnippet(s: string | null | undefined, max = 120): string {
  const clean = String(s ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * VERIFY-ONLY comparison of a user's expense against a document. Returns issues;
 * NEVER returns replacement values to auto-apply. Amounts are integer kopeks.
 */
export function compareExpenseAgainstDocument(
  user: { amountKopeks: number; date: string | null; description: string | null },
  doc: { amountKopeks: number | null; date: string | null; hasContent: boolean },
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  if (!doc.hasContent) {
    issues.push({ field: "document", severity: "warning", code: "DOCUMENT_UNREADABLE", message: "Не удалось прочитать содержимое документа для сверки.", expectedValue: null, documentValue: null, evidence: null });
    return issues;
  }
  if (doc.amountKopeks != null && doc.amountKopeks !== user.amountKopeks) {
    issues.push({ field: "amount", severity: "mismatch", code: "AMOUNT_MISMATCH", message: "Сумма расхода не совпадает с суммой в документе.", expectedValue: String(user.amountKopeks), documentValue: String(doc.amountKopeks), evidence: null });
  }
  if (doc.date && user.date && doc.date !== user.date) {
    issues.push({ field: "date", severity: "warning", code: "DATE_MISMATCH", message: "Дата расхода отличается от даты в документе.", expectedValue: user.date, documentValue: doc.date, evidence: null });
  }
  return issues;
}
