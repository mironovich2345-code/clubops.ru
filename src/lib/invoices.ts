import type { Invoice } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DataScope, AccessContext } from "@/lib/access";
import type { Role } from "@/lib/auth";

export type InvoiceStatus =
  | "draft"
  | "needs_review"
  | "approved_by_regional"
  | "approved_by_owner"
  | "paid"
  | "rejected"
  | "canceled";

export type InvoiceConfidence = "low" | "medium" | "high";

// --- Expense period (accounting month an invoice belongs to) ----------------
// `expensePeriod` ("YYYY-MM") decides which month an invoice counts in for
// expenses / profit / budget / analytics — independent of `paidAt` (when the
// money actually left). Payment reporting keeps using paidAt.

function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Accounting month for an invoice: stored expensePeriod, else derived from
 * invoiceDate → paidAt → createdAt. */
export function invoiceExpensePeriod(inv: {
  expensePeriod?: string | null;
  invoiceDate: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}): string {
  if (inv.expensePeriod && /^\d{4}-\d{2}$/.test(inv.expensePeriod)) return inv.expensePeriod;
  return monthKeyOf(inv.invoiceDate ?? inv.paidAt ?? inv.createdAt);
}

/** First day of a "YYYY-MM" month, or null. */
export function periodToDate(period: string): Date | null {
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1);
}

/** The date an invoice contributes to date-based expense analytics — a day
 * inside its expensePeriod (keeps invoiceDate's day when in the same month). */
export function invoiceAnalyticsDate(inv: {
  expensePeriod?: string | null;
  invoiceDate: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}): Date {
  const period = invoiceExpensePeriod(inv);
  const base = inv.invoiceDate ?? inv.paidAt ?? inv.createdAt;
  if (monthKeyOf(base) === period) return base;
  return periodToDate(period) ?? base;
}

const MONTHS_RU = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

/** "Май 2026" for a "YYYY-MM" period (or the raw value if malformed). */
export function formatExpensePeriod(period: string | null | undefined): string {
  if (!period) return "—";
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return period;
  return `${MONTHS_RU[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export const INVOICE_STATUSES: InvoiceStatus[] = [
  "draft",
  "needs_review",
  "approved_by_regional",
  "approved_by_owner",
  "paid",
  "rejected",
  "canceled",
];

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик",
  needs_review: "На согласовании",
  approved_by_regional: "Согласовано регионалом",
  approved_by_owner: "Согласовано собственником",
  paid: "Оплачено",
  rejected: "Отклонено",
  canceled: "Отменено",
  // legacy values (kept readable)
  approved: "Согласовано",
  unpaid: "Не оплачен",
  overdue: "Просрочен",
};

// Statuses that are not real obligations or spending — excluded from dashboard
// expenses, debts, budgets and analytics.
export function isDeadInvoiceStatus(status: string): boolean {
  return status === "rejected" || status === "canceled";
}

export const INVOICE_CONFIDENCE_LABELS: Record<string, string> = {
  low: "низкая",
  medium: "средняя",
  high: "высокая",
};

// --- Workflow: draft -> needs_review -> approved_* -> paid (or rejected) ------

export type InvoiceAction = "send_to_review" | "approve" | "reject" | "pay" | "cancel";

export const INVOICE_ACTION_LABELS: Record<InvoiceAction, string> = {
  send_to_review: "Отправить на согласование",
  approve: "Согласовать",
  reject: "Отклонить",
  pay: "Отметить оплачено",
  cancel: "Отменить счёт",
};

export const INVOICE_ACTION_AUDIT: Record<InvoiceAction, string> = {
  send_to_review: "invoice.sent_to_review",
  approve: "invoice.approved",
  reject: "invoice.rejected",
  pay: "invoice.paid",
  cancel: "invoice.canceled",
};

/** Actions that need an explicit "are you sure?" confirmation in the UI. */
export const INVOICE_DESTRUCTIVE_ACTIONS: InvoiceAction[] = ["reject", "cancel"];

type TransitionResult =
  | { ok: true; to: InvoiceStatus }
  | { ok: false; error: string };

function has(roles: readonly Role[], role: Role): boolean {
  return roles.includes(role);
}

/**
 * Resolves an action against the current status and the actor's effective
 * roles. Pure function — the single source of truth for who may do what.
 */
export function applyInvoiceAction(
  action: InvoiceAction,
  status: string,
  roles: readonly Role[],
): TransitionResult {
  const isOwner = has(roles, "owner");
  const isRegional = has(roles, "regional_director");
  const isAccountant = has(roles, "accountant");
  const isManager = has(roles, "manager");

  switch (action) {
    case "send_to_review":
      if (status !== "draft") return { ok: false, error: "Отправить на согласование можно только черновик" };
      if (!(isManager || isRegional || isOwner)) return { ok: false, error: "Недостаточно прав" };
      return { ok: true, to: "needs_review" };

    case "approve":
      if (!(isRegional || isOwner)) return { ok: false, error: "Недостаточно прав для согласования" };
      if (isOwner) {
        if (status === "needs_review" || status === "approved_by_regional") {
          return { ok: true, to: "approved_by_owner" };
        }
        return { ok: false, error: "Согласовать можно счёт на согласовании" };
      }
      if (status === "needs_review") return { ok: true, to: "approved_by_regional" };
      return { ok: false, error: "Согласовать можно счёт на согласовании" };

    case "reject":
      // Regional/owner may reject anything under review or already approved, as
      // long as it has not been paid.
      if (!(isRegional || isOwner)) return { ok: false, error: "Недостаточно прав для отклонения" };
      if (
        status === "needs_review" ||
        status === "approved_by_regional" ||
        status === "approved_by_owner"
      ) {
        return { ok: true, to: "rejected" };
      }
      return { ok: false, error: "Отклонить можно счёт на согласовании или согласованный (до оплаты)" };

    case "cancel":
      // A draft may be canceled by the people working on it. Paid invoices can
      // never be canceled — only a note may be added.
      if (!(isManager || isRegional || isOwner)) return { ok: false, error: "Недостаточно прав для отмены" };
      if (status === "draft") return { ok: true, to: "canceled" };
      return { ok: false, error: "Отменить можно только черновик" };

    case "pay":
      if (!(isAccountant || isOwner)) return { ok: false, error: "Недостаточно прав для отметки об оплате" };
      if (status === "approved_by_regional" || status === "approved_by_owner") {
        return { ok: true, to: "paid" };
      }
      return { ok: false, error: "Оплатить можно только согласованный счёт" };
  }
}

/** Actions the actor can currently perform — drives which buttons are shown. */
export function availableInvoiceActions(status: string, roles: readonly Role[]): InvoiceAction[] {
  return (Object.keys(INVOICE_ACTION_LABELS) as InvoiceAction[]).filter(
    (action) => applyInvoiceAction(action, status, roles).ok,
  );
}

/** Paid invoices are locked except for owner/accountant; others editable. */
export function canEditInvoice(status: string, roles: readonly Role[]): boolean {
  if (status !== "paid") return true;
  return has(roles, "owner") || has(roles, "accountant");
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
  if (invoice.status === "paid" || isDeadInvoiceStatus(invoice.status)) return false;
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
    } else if (isDeadInvoiceStatus(inv.status)) {
      // rejected + canceled — not a debt, not an expense.
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
