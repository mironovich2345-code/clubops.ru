import type { Expense } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DataScope, AccessContext } from "@/lib/access";

// Legacy Russian category list (manual entries / imports). Kept for readability.
export const EXPENSE_CATEGORIES = [
  "Аренда",
  "Зарплата",
  "Реклама",
  "Хозтовары",
  "Ремонт",
  "Оборудование",
  "Коммунальные",
  "Налоги",
  "Закупки",
  "Прочее",
] as const;

export const PAYMENT_METHODS = ["Наличные", "Карта", "Банковский перевод"] as const;

// Canonical payment methods (stored as keys). Cash expenses are routed to the
// club's ИП (see saveExpense).
export const PAYMENT_METHOD_OPTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "cash", label: "Наличные" },
  { key: "card", label: "Карта" },
  { key: "sbp", label: "СБП" },
  { key: "bank_transfer", label: "Банковский перевод" },
  { key: "other", label: "Другое" },
];
export const PAYMENT_METHOD_KEYS = PAYMENT_METHOD_OPTIONS.map((o) => o.key);
export const PAYMENT_METHOD_LABELS: Record<string, string> = Object.fromEntries(
  PAYMENT_METHOD_OPTIONS.map((o) => [o.key, o.label]),
);

// Expense document types (receipt / transfer / manual / payroll_statement).
export const EXPENSE_TYPES = ["receipt", "transfer", "manual", "payroll_statement"] as const;
export const EXPENSE_TYPE_LABELS: Record<string, string> = {
  receipt: "Чек",
  transfer: "Перевод",
  manual: "Вручную",
  payroll_statement: "Зарплатная ведомость",
};

// Category keys used by the receipts/transfers flow, with Russian labels.
export const EXPENSE_CATEGORY_OPTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "advertising", label: "Реклама" },
  { key: "household", label: "Хозрасходы" },
  { key: "builders", label: "Строители" },
  { key: "rent", label: "Аренда" },
  { key: "investments", label: "Вложения" },
  { key: "refunds", label: "Возвраты" },
  { key: "salary", label: "Зарплата" },
  { key: "other", label: "Прочее" },
];

export const EXPENSE_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  EXPENSE_CATEGORY_OPTIONS.map((o) => [o.key, o.label]),
);

/** Human label for a stored category value (key or legacy Russian text). */
export function expenseCategoryLabel(category: string | null): string {
  if (!category) return "—";
  return EXPENSE_CATEGORY_LABELS[category] ?? category;
}

export type ExpenseWithRelations = Expense & {
  club: { id: string; name: string; city: string };
  createdBy: { id: string; name: string };
};

/** Single expense, scoped to the current access context (company + allowed clubs). */
export async function getExpenseForContext(
  ctx: AccessContext,
  expenseId: string,
): Promise<ExpenseWithRelations | null> {
  if (!ctx.selectedCompanyId) return null;
  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
    include: {
      club: { select: { id: true, name: true, city: true } },
      createdBy: { select: { id: true, name: true } },
    },
  });
  if (!expense) return null;
  if (expense.companyId !== ctx.selectedCompanyId) return null;
  if (!ctx.allowedClubIds.includes(expense.clubId)) return null;
  return expense as ExpenseWithRelations;
}

export async function getExpensesForScope(
  scope: DataScope,
): Promise<ExpenseWithRelations[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  return prisma.expense.findMany({
    where: { companyId: scope.company.id, clubId: { in: scope.clubIds } },
    orderBy: { expenseDate: "desc" },
    include: {
      club: true,
      createdBy: { select: { id: true, name: true } },
    },
  });
}

type MonthRange = { start: number; end: number };

function monthRange(year: number, monthIndex: number): MonthRange {
  return {
    start: new Date(year, monthIndex, 1).getTime(),
    end: new Date(year, monthIndex + 1, 1).getTime(),
  };
}

function inRange(date: Date, range: MonthRange): boolean {
  const t = date.getTime();
  return t >= range.start && t < range.end;
}

export type CategoryTotal = { category: string; amountKopeks: number };

export type ExpenseSummary = {
  currentMonthKopeks: number;
  previousMonthKopeks: number;
  changeKopeks: number;
  /** null when the previous month has no expenses (percent is undefined) */
  changePercent: number | null;
  largestCategory: CategoryTotal | null;
  /** current-month totals per category, sorted by amount desc */
  categoryTotals: CategoryTotal[];
};

export function summarizeExpenses(
  expenses: Array<{ amountKopeks: number; expenseDate: Date; category: string }>,
  reference: Date,
): ExpenseSummary {
  const year = reference.getFullYear();
  const month = reference.getMonth();
  const current = monthRange(year, month);
  const previous = monthRange(year, month - 1);

  let currentMonthKopeks = 0;
  let previousMonthKopeks = 0;
  const byCategory = new Map<string, number>();

  for (const e of expenses) {
    if (inRange(e.expenseDate, current)) {
      currentMonthKopeks += e.amountKopeks;
      byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amountKopeks);
    } else if (inRange(e.expenseDate, previous)) {
      previousMonthKopeks += e.amountKopeks;
    }
  }

  const categoryTotals: CategoryTotal[] = [...byCategory.entries()]
    .map(([category, amountKopeks]) => ({ category, amountKopeks }))
    .sort((a, b) => b.amountKopeks - a.amountKopeks);

  const changeKopeks = currentMonthKopeks - previousMonthKopeks;
  const changePercent =
    previousMonthKopeks === 0 ? null : (changeKopeks / previousMonthKopeks) * 100;

  return {
    currentMonthKopeks,
    previousMonthKopeks,
    changeKopeks,
    changePercent,
    largestCategory: categoryTotals[0] ?? null,
    categoryTotals,
  };
}
