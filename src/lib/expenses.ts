import type { Expense } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DataScope } from "@/lib/access";

// Recommended categories shown in the create form. `category` is stored as TEXT
// (SQLite has no enums), so other values are technically allowed — these are the
// suggested defaults.
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

// Optional helper list for the payment-method field (nullable).
export const PAYMENT_METHODS = [
  "Наличные",
  "Карта",
  "Банковский перевод",
] as const;

export type ExpenseWithRelations = Expense & {
  club: { id: string; name: string; city: string };
  createdBy: { id: string; name: string };
};

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
