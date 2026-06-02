import type { Sale } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DataScope } from "@/lib/access";

// Default sources shown in the create form. `source` is stored as TEXT (SQLite
// has no enums), so other values are technically allowed — these are the
// suggested defaults.
export const SALE_SOURCES = [
  "Абонементы",
  "Персональные тренировки",
  "Продления",
  "Заморозки",
  "Товары",
  "Прочее",
] as const;

export type SaleWithRelations = Sale & {
  club: { id: string; name: string; city: string };
  createdBy: { id: string; name: string };
};

export async function getSalesForScope(
  scope: DataScope,
): Promise<SaleWithRelations[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  return prisma.sale.findMany({
    where: { companyId: scope.company.id, clubId: { in: scope.clubIds } },
    orderBy: { saleDate: "desc" },
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

export type SourceTotal = { source: string; amountKopeks: number };

export type SaleSummary = {
  currentMonthKopeks: number;
  previousMonthKopeks: number;
  changeKopeks: number;
  /** null when the previous month has no sales (percent is undefined) */
  changePercent: number | null;
  topSource: SourceTotal | null;
  /** current-month totals per source, sorted by amount desc */
  sourceTotals: SourceTotal[];
};

export function summarizeSales(
  sales: Array<{ amountKopeks: number; saleDate: Date; source: string }>,
  reference: Date,
): SaleSummary {
  const year = reference.getFullYear();
  const month = reference.getMonth();
  const current = monthRange(year, month);
  const previous = monthRange(year, month - 1);

  let currentMonthKopeks = 0;
  let previousMonthKopeks = 0;
  const bySource = new Map<string, number>();

  for (const s of sales) {
    if (inRange(s.saleDate, current)) {
      currentMonthKopeks += s.amountKopeks;
      bySource.set(s.source, (bySource.get(s.source) ?? 0) + s.amountKopeks);
    } else if (inRange(s.saleDate, previous)) {
      previousMonthKopeks += s.amountKopeks;
    }
  }

  const sourceTotals: SourceTotal[] = [...bySource.entries()]
    .map(([source, amountKopeks]) => ({ source, amountKopeks }))
    .sort((a, b) => b.amountKopeks - a.amountKopeks);

  const changeKopeks = currentMonthKopeks - previousMonthKopeks;
  const changePercent =
    previousMonthKopeks === 0 ? null : (changeKopeks / previousMonthKopeks) * 100;

  return {
    currentMonthKopeks,
    previousMonthKopeks,
    changeKopeks,
    changePercent,
    topSource: sourceTotals[0] ?? null,
    sourceTotals,
  };
}
