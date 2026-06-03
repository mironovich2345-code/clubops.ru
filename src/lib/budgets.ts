import type { Budget, BudgetApprovalRequest } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DataScope, AccessContext } from "@/lib/access";
import { EXPENSE_CATEGORY_OPTIONS, EXPENSE_CATEGORY_LABELS } from "@/lib/expenses";

// Budget categories reuse the expense category keys.
export const BUDGET_CATEGORIES = EXPENSE_CATEGORY_OPTIONS;

export function budgetCategoryLabel(key: string): string {
  return EXPENSE_CATEGORY_LABELS[key] ?? key;
}

// Thresholds (percent over the limit).
export const REGIONAL_MAX_OVER_PERCENT = 5; // RD may approve up to +5%
export const OWNER_DOUBLE_CONFIRM_PERCENT = 20; // owner approving >20% needs double confirm

export const BUDGET_REQUEST_STATUS_LABELS: Record<string, string> = {
  pending_regional: "Ожидает регионального директора",
  pending_owner: "Ожидает собственника",
  approved: "Согласовано",
  rejected: "Отклонено",
};

export function currentMonthKey(reference: Date): string {
  const y = reference.getFullYear();
  const m = String(reference.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function isValidMonth(month: string): boolean {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return false;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12;
}

function monthRange(month: string): { start: number; end: number } | null {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return { start: new Date(y, mo - 1, 1).getTime(), end: new Date(y, mo, 1).getTime() };
}

const APPROVED_INVOICE_STATUSES = ["approved_by_regional", "approved_by_owner", "paid"];
const APPROVED_REFUND_STATUSES = ["approved_by_regional", "approved_by_owner", "paid"];

/**
 * Used budget for a club+category+month. Includes approved/paid invoices,
 * confirmed expenses, and (for the "refunds" category) approved/paid refunds.
 */
export async function computeUsedKopeks(
  clubId: string,
  category: string,
  month: string,
): Promise<number> {
  const range = monthRange(month);
  if (!range) return 0;
  const inRange = (date: Date) => {
    const t = date.getTime();
    return t >= range.start && t < range.end;
  };

  let used = 0;

  const invoices = await prisma.invoice.findMany({
    where: { clubId, expenseCategory: category, status: { in: APPROVED_INVOICE_STATUSES } },
    select: { amountKopeks: true, invoiceDate: true, createdAt: true },
  });
  for (const i of invoices) if (inRange(i.invoiceDate ?? i.createdAt)) used += i.amountKopeks;

  const expenses = await prisma.expense.findMany({
    where: { clubId, category, status: "confirmed" },
    select: { amountKopeks: true, expenseDate: true },
  });
  for (const e of expenses) if (inRange(e.expenseDate)) used += e.amountKopeks;

  if (category === "refunds") {
    const refunds = await prisma.refund.findMany({
      where: { clubId, status: { in: APPROVED_REFUND_STATUSES } },
      select: { amountKopeks: true, refundDate: true, createdAt: true },
    });
    for (const r of refunds) if (inRange(r.refundDate ?? r.createdAt)) used += r.amountKopeks;
  }

  return used;
}

export type BudgetRow = {
  category: string;
  label: string;
  limitKopeks: number;
  usedKopeks: number;
  remainingKopeks: number;
  percentUsed: number | null; // null when no limit set
  hasLimit: boolean;
};

/** Per-category budget overview for one club + month. */
export async function getBudgetOverview(clubId: string, month: string): Promise<BudgetRow[]> {
  const budgets = await prisma.budget.findMany({ where: { clubId, month } });
  const limitByCategory = new Map(budgets.map((b) => [b.category, b.limitAmountKopeks]));

  const rows: BudgetRow[] = [];
  for (const { key, label } of BUDGET_CATEGORIES) {
    const usedKopeks = await computeUsedKopeks(clubId, key, month);
    const hasLimit = limitByCategory.has(key);
    const limitKopeks = limitByCategory.get(key) ?? 0;
    rows.push({
      category: key,
      label,
      limitKopeks,
      usedKopeks,
      remainingKopeks: limitKopeks - usedKopeks,
      percentUsed: hasLimit && limitKopeks > 0 ? (usedKopeks / limitKopeks) * 100 : null,
      hasLimit,
    });
  }
  return rows;
}

export type BudgetRequestWithRelations = BudgetApprovalRequest & {
  club: { id: string; name: string };
  requestedBy: { id: string; name: string };
};

export async function getBudgetRequestsForScope(
  scope: DataScope,
): Promise<BudgetRequestWithRelations[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  const rows = await prisma.budgetApprovalRequest.findMany({
    where: { companyId: scope.company.id, clubId: { in: scope.clubIds } },
    orderBy: { createdAt: "desc" },
    include: {
      club: { select: { id: true, name: true } },
      requestedBy: { select: { id: true, name: true } },
    },
  });
  return rows as BudgetRequestWithRelations[];
}

export async function getBudgetRequestForContext(
  ctx: AccessContext,
  requestId: string,
): Promise<BudgetApprovalRequest | null> {
  if (!ctx.selectedCompanyId) return null;
  const req = await prisma.budgetApprovalRequest.findUnique({ where: { id: requestId } });
  if (!req) return null;
  if (req.companyId !== ctx.selectedCompanyId) return null;
  if (!ctx.allowedClubIds.includes(req.clubId)) return null;
  return req;
}

export type { Budget };
