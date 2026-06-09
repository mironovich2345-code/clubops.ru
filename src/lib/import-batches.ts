// Import safety layer: tracks each Excel import as an ImportBatch so identical
// files can be blocked, duplicate rows skipped, and a whole import undone.
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/access";
import { EXPENSE_ACTIVE_STATUSES } from "@/lib/expenses";

export type ImportType = "sales_reports" | "expenses" | "invoices";

export const IMPORT_TYPE_LABELS: Record<ImportType, string> = {
  sales_reports: "Сменные отчёты",
  expenses: "Расходы",
  invoices: "Счета",
};

/** Expense status assigned to rows whose import was reverted (excluded from all
 * aggregates, which only count status === "confirmed"). */
export const EXPENSE_STATUS_IMPORT_REVERTED = "import_reverted";

export function fileSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// --- duplicate-text normalization (Part 4) ---------------------------------

const ORG_NOISE = new Set(["ооо", "ип", "зао", "оао", "пао", "ао"]);

/**
 * Normalize a counterparty / store / payer name for duplicate comparison:
 * lowercase, ё→е, drop quotes/punctuation, drop ООО/ИП-style org-form noise,
 * collapse spaces. null/undefined → "". Kept deliberately simple.
 */
export function normalizeDuplicateText(value: unknown): string {
  if (value == null) return "";
  const cleaned = String(value)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/["'«»`.,]/g, " ");
  return cleaned
    .split(/\s+/)
    .filter((t) => t && !ORG_NOISE.has(t))
    .join(" ")
    .trim();
}

const dayKey = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;

// --- duplicate-row keys (Part 3) -------------------------------------------

export type ExpenseDupFields = {
  companyId: string;
  clubId: string;
  expenseDate: Date;
  amountKopeks: number;
  category: string;
  paymentMethod: string | null;
  vendorName: string | null;
  legalEntityId: string | null;
};

export function expenseDupKey(e: ExpenseDupFields): string {
  return [
    e.companyId,
    e.clubId,
    dayKey(e.expenseDate),
    e.amountKopeks,
    e.category,
    e.paymentMethod ?? "",
    normalizeDuplicateText(e.vendorName),
    e.legalEntityId ?? "",
  ].join("|");
}

export type InvoiceDupFields = {
  companyId: string;
  clubId: string;
  invoiceDate: Date;
  amountKopeks: number;
  counterpartyName: string | null;
  invoiceNumber: string | null;
  legalEntityId: string | null;
};

export function invoiceDupKey(i: InvoiceDupFields): string {
  return [
    i.companyId,
    i.clubId,
    dayKey(i.invoiceDate),
    i.amountKopeks,
    normalizeDuplicateText(i.counterpartyName),
    normalizeDuplicateText(i.invoiceNumber),
    i.legalEntityId ?? "",
  ].join("|");
}

/** Existing expense dup keys for the scope. Only ACTIVE rows count — canceled /
 * reverted / rejected rows are ignored so the same row can be re-imported once
 * its earlier copy is no longer active. */
export async function loadExpenseDupKeys(companyId: string, clubIds: string[]): Promise<Set<string>> {
  if (clubIds.length === 0) return new Set();
  const rows = await prisma.expense.findMany({
    where: { companyId, clubId: { in: clubIds }, status: { in: [...EXPENSE_ACTIVE_STATUSES] } },
    select: { companyId: true, clubId: true, expenseDate: true, amountKopeks: true, category: true, paymentMethod: true, vendorName: true, legalEntityId: true },
  });
  return new Set(rows.map(expenseDupKey));
}

/** Existing (active) invoice dup keys for the scope. Canceled invoices (incl.
 * reverted imports) are excluded so a file can be re-imported after undo. */
export async function loadInvoiceDupKeys(companyId: string, clubIds: string[]): Promise<Set<string>> {
  if (clubIds.length === 0) return new Set();
  const rows = await prisma.invoice.findMany({
    where: { companyId, clubId: { in: clubIds }, status: { not: "canceled" }, invoiceDate: { not: null } },
    select: { companyId: true, clubId: true, invoiceDate: true, amountKopeks: true, counterpartyName: true, invoiceNumber: true, legalEntityId: true },
  });
  return new Set(
    rows
      .filter((r): r is typeof r & { invoiceDate: Date } => r.invoiceDate != null)
      .map((r) => invoiceDupKey(r)),
  );
}

// --- file-hash blocking (Part 2) -------------------------------------------

/** A previous, non-reverted import of the exact same file (by hash), if any. */
export async function findDuplicateFileBatch(
  companyId: string,
  type: ImportType,
  fileHash: string,
): Promise<{ createdAt: Date; createdByUserId: string } | null> {
  if (!fileHash) return null;
  return prisma.importBatch.findFirst({
    where: { companyId, type, fileHash, status: { not: "reverted" } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, createdByUserId: true },
  });
}

/** Number of still-active financial rows created by an expense import batch
 * (confirmed / waiting_budget_approval). Canceled / reverted / rejected are
 * inactive. */
export async function expenseBatchActiveCount(batchId: string): Promise<number> {
  return prisma.expense.count({
    where: { importBatchId: batchId, status: { in: [...EXPENSE_ACTIVE_STATUSES] } },
  });
}

/**
 * For expenses, a re-import is only blocked while a previous import of the same
 * file still has at least one ACTIVE row. Once every imported row is inactive
 * (canceled / import_reverted / rejected) the same file may be imported again.
 */
export async function findActiveExpenseFileBatch(
  companyId: string,
  fileHash: string,
): Promise<{ createdAt: Date; createdByUserId: string } | null> {
  if (!fileHash) return null;
  const batches = await prisma.importBatch.findMany({
    where: { companyId, type: "expenses", fileHash },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, createdByUserId: true },
  });
  for (const b of batches) {
    if ((await expenseBatchActiveCount(b.id)) > 0) {
      return { createdAt: b.createdAt, createdByUserId: b.createdByUserId };
    }
  }
  return null;
}

/**
 * Mark an expense import batch `reverted` once all the rows it created are
 * inactive (called after a single or bulk cancel). Only acts on a still
 * `completed` expense batch; returns true when it flips the status.
 */
export async function revertExpenseBatchIfAllInactive(
  batchId: string,
  opts: { userId: string; companyId: string; clubId: string | null; action: string },
): Promise<boolean> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { id: true, status: true, type: true },
  });
  if (!batch || batch.type !== "expenses" || batch.status !== "completed") return false;
  if ((await expenseBatchActiveCount(batchId)) > 0) return false;

  await prisma.importBatch.update({
    where: { id: batchId },
    data: { status: "reverted", revertedByUserId: opts.userId, revertedAt: new Date() },
  });
  await recordAudit({
    action: opts.action,
    entityType: "ImportBatch",
    entityId: batchId,
    companyId: opts.companyId,
    clubId: opts.clubId,
    userId: opts.userId,
    metadata: { type: "expenses", trigger: opts.action },
  });
  return true;
}

// --- batch lifecycle -------------------------------------------------------

export async function createImportBatch(data: {
  companyId: string;
  clubId: string | null;
  type: ImportType;
  fileName: string | null;
  fileHash: string | null;
  createdByUserId: string;
}): Promise<string> {
  const b = await prisma.importBatch.create({ data: { ...data, status: "completed" } });
  return b.id;
}

export async function finalizeImportBatch(
  id: string,
  counts: { created: number; skipped: number; duplicated: number; errored: number },
  summary: unknown,
): Promise<void> {
  await prisma.importBatch.update({
    where: { id },
    data: {
      rowsCreated: counts.created,
      rowsSkipped: counts.skipped,
      rowsDuplicated: counts.duplicated,
      rowsErrored: counts.errored,
      summaryJson: JSON.stringify(summary ?? {}),
    },
  });
}

export type LastImportBatch = {
  id: string;
  type: string;
  fileName: string | null;
  createdAt: Date;
  createdBy: string;
  rowsCreated: number;
  rowsSkipped: number;
  rowsDuplicated: number;
  rowsErrored: number;
  status: string;
};

/** Latest completed batch of the given type visible in the user's scope. */
export async function getLastImportBatch(
  companyId: string,
  type: ImportType,
  clubIds: string[],
  userId: string,
): Promise<LastImportBatch | null> {
  const b = await prisma.importBatch.findFirst({
    where: {
      companyId,
      type,
      status: "completed",
      OR: [{ clubId: { in: clubIds } }, { clubId: null, createdByUserId: userId }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (!b) return null;
  const u = await prisma.user.findUnique({ where: { id: b.createdByUserId }, select: { name: true } });
  return {
    id: b.id,
    type: b.type,
    fileName: b.fileName,
    createdAt: b.createdAt,
    createdBy: u?.name ?? "—",
    rowsCreated: b.rowsCreated,
    rowsSkipped: b.rowsSkipped,
    rowsDuplicated: b.rowsDuplicated,
    rowsErrored: b.rowsErrored,
    status: b.status,
  };
}

// --- revert (Part 5) -------------------------------------------------------

/**
 * Soft-revert all rows created by a batch. Returns the reverted/kept counts.
 * Records with downstream actions (approved/paid/confirmed) are kept, never
 * deleted. Caller is responsible for permission + scope checks.
 */
export async function revertImportBatchRows(
  batchId: string,
  type: string,
): Promise<{ reverted: number; kept: number }> {
  let reverted = 0;
  let kept = 0;

  if (type === "expenses") {
    const expenses = await prisma.expense.findMany({ where: { importBatchId: batchId }, select: { id: true, status: true } });
    for (const e of expenses) {
      if (e.status === EXPENSE_STATUS_IMPORT_REVERTED) continue;
      // A budget-approval decision is a downstream action — keep such expenses.
      const req = await prisma.budgetApprovalRequest.findFirst({ where: { sourceType: "expense", sourceId: e.id }, select: { id: true, status: true } });
      if (req && req.status !== "pending") {
        kept++;
        continue;
      }
      if (req) await prisma.budgetApprovalRequest.delete({ where: { id: req.id } });
      await prisma.expense.update({ where: { id: e.id }, data: { status: EXPENSE_STATUS_IMPORT_REVERTED } });
      reverted++;
    }
  } else if (type === "invoices") {
    // Only undo invoices with no workflow progress (still draft / needs_review).
    const invoices = await prisma.invoice.findMany({ where: { importBatchId: batchId }, select: { id: true, status: true } });
    for (const i of invoices) {
      if (i.status === "canceled") continue;
      if (i.status === "draft" || i.status === "needs_review") {
        await prisma.invoice.update({ where: { id: i.id }, data: { status: "canceled" } });
        reverted++;
      } else {
        kept++; // approved / paid / rejected — downstream action happened
      }
    }
  } else if (type === "sales_reports") {
    // Cancel only pending reports; never touch confirmed ones.
    const reports = await prisma.salesReport.findMany({ where: { importBatchId: batchId }, select: { id: true, status: true } });
    for (const r of reports) {
      if (r.status === "canceled") continue;
      if (r.status === "pending_accountant") {
        await prisma.salesReport.update({ where: { id: r.id }, data: { status: "canceled" } });
        reverted++;
      } else {
        kept++;
      }
    }
  }

  return { reverted, kept };
}
