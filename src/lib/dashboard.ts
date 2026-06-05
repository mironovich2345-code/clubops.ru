import type { SaleSummary } from "@/lib/sales";
import type { ExpenseSummary } from "@/lib/expenses";

// Profit = sales - expenses. All amounts in kopeks.
export type ProfitSummary = {
  currentSalesKopeks: number;
  currentExpensesKopeks: number;
  currentProfitKopeks: number;
  previousProfitKopeks: number;
  profitChangeKopeks: number;
  /** null when the previous month had no profit to compare against */
  profitChangePercent: number | null;
  /** profit / sales, null when there were no sales */
  marginPercent: number | null;
  salesGrowthPercent: number | null;
  expenseGrowthPercent: number | null;
};

export function profitSummary(
  sales: SaleSummary,
  expenses: ExpenseSummary,
): ProfitSummary {
  const currentProfitKopeks = sales.currentMonthKopeks - expenses.currentMonthKopeks;
  const previousProfitKopeks = sales.previousMonthKopeks - expenses.previousMonthKopeks;
  const profitChangeKopeks = currentProfitKopeks - previousProfitKopeks;

  const profitChangePercent =
    previousProfitKopeks > 0
      ? (profitChangeKopeks / previousProfitKopeks) * 100
      : null;

  const marginPercent =
    sales.currentMonthKopeks > 0
      ? (currentProfitKopeks / sales.currentMonthKopeks) * 100
      : null;

  return {
    currentSalesKopeks: sales.currentMonthKopeks,
    currentExpensesKopeks: expenses.currentMonthKopeks,
    currentProfitKopeks,
    previousProfitKopeks,
    profitChangeKopeks,
    profitChangePercent,
    marginPercent,
    salesGrowthPercent: sales.changePercent,
    expenseGrowthPercent: expenses.changePercent,
  };
}

export type ClubFinance = {
  clubId: string;
  clubName: string;
  salesKopeks: number;
  expensesKopeks: number;
  profitKopeks: number;
};

type MonthRange = { start: number; end: number };

function currentMonthRange(reference: Date): MonthRange {
  const year = reference.getFullYear();
  const month = reference.getMonth();
  return {
    start: new Date(year, month, 1).getTime(),
    end: new Date(year, month + 1, 1).getTime(),
  };
}

function inRange(date: Date, range: MonthRange): boolean {
  const t = date.getTime();
  return t >= range.start && t < range.end;
}

/** Current-month sales / expenses / profit per club, sorted by profit desc. */
export function clubComparison(
  clubs: Array<{ id: string; name: string }>,
  sales: Array<{ clubId: string; amountKopeks: number; saleDate: Date }>,
  expenses: Array<{ clubId: string; amountKopeks: number; expenseDate: Date }>,
  reference: Date,
): ClubFinance[] {
  const range = currentMonthRange(reference);
  const byClub = new Map<string, ClubFinance>();
  for (const club of clubs) {
    byClub.set(club.id, {
      clubId: club.id,
      clubName: club.name,
      salesKopeks: 0,
      expensesKopeks: 0,
      profitKopeks: 0,
    });
  }

  for (const s of sales) {
    if (!inRange(s.saleDate, range)) continue;
    const row = byClub.get(s.clubId);
    if (row) row.salesKopeks += s.amountKopeks;
  }
  for (const e of expenses) {
    if (!inRange(e.expenseDate, range)) continue;
    const row = byClub.get(e.clubId);
    if (row) row.expensesKopeks += e.amountKopeks;
  }

  for (const row of byClub.values()) {
    row.profitKopeks = row.salesKopeks - row.expensesKopeks;
  }

  return [...byClub.values()].sort((a, b) => b.profitKopeks - a.profitKopeks);
}

export type ClubRankRow = ClubFinance & {
  prevProfitKopeks: number;
  /** profit change vs the previous month (null when no comparable prior profit) */
  profitTrendPercent: number | null;
  planKopeks: number;
  /** confirmed sales / plan for this club's current-month plan (null when no plan) */
  planPercent: number | null;
};

/** Club ranking: current sales/expenses/profit + month-over-month trend + plan %. */
export function clubRanking(
  clubs: Array<{ id: string; name: string }>,
  sales: Array<{ clubId: string; amountKopeks: number; saleDate: Date }>,
  expenses: Array<{ clubId: string; amountKopeks: number; expenseDate: Date }>,
  reference: Date,
  planByClub: Map<string, number>,
): ClubRankRow[] {
  const cur = currentMonthRange(reference);
  const prev = currentMonthRange(new Date(reference.getFullYear(), reference.getMonth() - 1, 1));

  const byClub = new Map<string, ClubRankRow>();
  for (const club of clubs) {
    byClub.set(club.id, {
      clubId: club.id,
      clubName: club.name,
      salesKopeks: 0,
      expensesKopeks: 0,
      profitKopeks: 0,
      prevProfitKopeks: 0,
      profitTrendPercent: null,
      planKopeks: planByClub.get(club.id) ?? 0,
      planPercent: null,
    });
  }
  const prevSales = new Map<string, number>();
  const prevExpenses = new Map<string, number>();

  for (const s of sales) {
    if (inRange(s.saleDate, cur)) {
      const r = byClub.get(s.clubId);
      if (r) r.salesKopeks += s.amountKopeks;
    } else if (inRange(s.saleDate, prev)) {
      prevSales.set(s.clubId, (prevSales.get(s.clubId) ?? 0) + s.amountKopeks);
    }
  }
  for (const e of expenses) {
    if (inRange(e.expenseDate, cur)) {
      const r = byClub.get(e.clubId);
      if (r) r.expensesKopeks += e.amountKopeks;
    } else if (inRange(e.expenseDate, prev)) {
      prevExpenses.set(e.clubId, (prevExpenses.get(e.clubId) ?? 0) + e.amountKopeks);
    }
  }
  for (const r of byClub.values()) {
    r.profitKopeks = r.salesKopeks - r.expensesKopeks;
    r.prevProfitKopeks = (prevSales.get(r.clubId) ?? 0) - (prevExpenses.get(r.clubId) ?? 0);
    r.profitTrendPercent =
      r.prevProfitKopeks > 0 ? ((r.profitKopeks - r.prevProfitKopeks) / r.prevProfitKopeks) * 100 : null;
    r.planPercent = r.planKopeks > 0 ? (r.salesKopeks / r.planKopeks) * 100 : null;
  }
  return [...byClub.values()].sort((a, b) => b.profitKopeks - a.profitKopeks);
}
