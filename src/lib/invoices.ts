import type { Invoice } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DataScope, AccessContext } from "@/lib/access";
import type { Role } from "@/lib/auth";

export type InvoiceStatus = "draft" | "needs_review" | "approved" | "paid" | "rejected";
export type InvoiceConfidence = "low" | "medium" | "high";

export const INVOICE_STATUSES: InvoiceStatus[] = [
  "draft",
  "needs_review",
  "approved",
  "paid",
  "rejected",
];

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик",
  needs_review: "На проверке",
  approved: "Утверждён",
  paid: "Оплачен",
  rejected: "Отклонён",
  // legacy values (kept readable)
  unpaid: "Не оплачен",
  overdue: "Просрочен",
};

export const INVOICE_CONFIDENCE_LABELS: Record<string, string> = {
  low: "низкая",
  medium: "средняя",
  high: "высокая",
};

// Statuses a manager (and only a manager) is NOT allowed to set.
const RESTRICTED_STATUSES: InvoiceStatus[] = ["approved", "paid", "rejected"];

const STATUS_MANAGERS: Role[] = ["owner", "regional_director", "accountant"];

/** Owner/RD/accountant can change to any status; a manager-only user cannot approve/pay/reject. */
export function canManageInvoiceStatus(roles: readonly Role[]): boolean {
  return roles.some((r) => STATUS_MANAGERS.includes(r));
}

export function allowedStatusesForRoles(roles: readonly Role[]): InvoiceStatus[] {
  return canManageInvoiceStatus(roles)
    ? INVOICE_STATUSES
    : INVOICE_STATUSES.filter((s) => !RESTRICTED_STATUSES.includes(s));
}

export type InvoiceWithClub = Invoice & {
  club: { id: string; name: string; city: string };
};

export async function getInvoicesForScope(scope: DataScope): Promise<InvoiceWithClub[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  const invoices = await prisma.invoice.findMany({
    where: { companyId: scope.company.id, clubId: { in: scope.clubIds } },
    orderBy: { createdAt: "desc" },
    include: { club: { select: { id: true, name: true, city: true } } },
  });
  return invoices as InvoiceWithClub[];
}

/** Single invoice, scoped to the current access context (company + allowed clubs). */
export async function getInvoiceForContext(
  ctx: AccessContext,
  invoiceId: string,
): Promise<InvoiceWithClub | null> {
  if (!ctx.selectedCompanyId) return null;
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { club: { select: { id: true, name: true, city: true } } },
  });
  if (!invoice) return null;
  if (invoice.companyId !== ctx.selectedCompanyId) return null;
  if (!ctx.allowedClubIds.includes(invoice.clubId)) return null;
  return invoice as InvoiceWithClub;
}

// --- Dashboard helpers (kept; null-safe for the new nullable dueDate) ---------

export function isOverdue(invoice: { status: string; dueDate: Date | null }): boolean {
  if (invoice.status === "paid" || invoice.status === "rejected") return false;
  if (!invoice.dueDate) return false;
  return invoice.dueDate.getTime() < Date.now();
}

export type StatusSummary = {
  unpaid: { count: number; amountKopeks: number };
  overdue: { count: number; amountKopeks: number };
  paid: { count: number; amountKopeks: number };
  rejected: { count: number; amountKopeks: number };
};

export function summarize(
  invoices: Array<{ status: string; dueDate: Date | null; amountKopeks: number }>,
): StatusSummary {
  const summary: StatusSummary = {
    unpaid: { count: 0, amountKopeks: 0 },
    overdue: { count: 0, amountKopeks: 0 },
    paid: { count: 0, amountKopeks: 0 },
    rejected: { count: 0, amountKopeks: 0 },
  };
  const now = Date.now();
  for (const inv of invoices) {
    if (inv.status === "paid") {
      summary.paid.count += 1;
      summary.paid.amountKopeks += inv.amountKopeks;
    } else if (inv.status === "rejected") {
      summary.rejected.count += 1;
      summary.rejected.amountKopeks += inv.amountKopeks;
    } else if (inv.dueDate && inv.dueDate.getTime() < now) {
      summary.overdue.count += 1;
      summary.overdue.amountKopeks += inv.amountKopeks;
    } else {
      summary.unpaid.count += 1;
      summary.unpaid.amountKopeks += inv.amountKopeks;
    }
  }
  return summary;
}
