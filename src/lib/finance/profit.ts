// REM-05 — the ONE official profit service (spec §7, BD-03).
//
//   profit = recognized OFD revenue − recognized expenses
//
// Revenue is the canonical OFD net aggregate already used by the product (income −
// OFD fiscal returns); client Refund records are NOT subtracted from revenue — they
// are a separate recognized expense (BD-REFUND). «Приход Иное», internal transfers,
// collections, withdrawals, cash balances, payments and obligations are NOT revenue
// or expense here. Expenses come ONLY from loadRecognizedExpenses (single source).

import { prisma } from "@/lib/prisma";
import type { DbClient } from "@/lib/db-client";
import { loadOfdManagementOverview } from "@/lib/analytics/ofd-management";
import { loadRecognizedExpenses } from "./recognized-expense";
import { PROFIT_FORMULA_VERSION } from "./recognition";

export type ProfitInput = {
  companyId: string;
  allowedClubIds: string[];
  months: string[]; // "YYYY-MM" accounting months
  clubId?: string | null;
  legalEntityId?: string | null;
  db?: DbClient;
};

export type ProfitResult = {
  revenueKopeks: number;
  expenseKopeks: number;
  profitKopeks: number;
  revenueBreakdown: { ofdNetKopeks: number; ofdIncomeKopeks: number; ofdReturnsKopeks: number };
  expenseBreakdown: Record<string, number>; // by source type
  warnings: string[];
  formulaVersion: string;
};

function monthBounds(month: string): { start: Date; end: Date } | null {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return { start: new Date(y, mo - 1, 1), end: new Date(y, mo, 1) };
}

/** Canonical recognized OFD revenue (net) for a scope across the given months. */
export async function recognizedOfdRevenue(
  companyId: string,
  clubIds: string[],
  months: string[],
): Promise<{ netKopeks: number; incomeKopeks: number; returnsKopeks: number }> {
  let net = 0;
  let income = 0;
  let returns = 0;
  for (const month of months) {
    const b = monthBounds(month);
    if (!b) continue;
    const ov = await loadOfdManagementOverview(companyId, clubIds, b.start, b.end);
    net += ov.totals.netKopeks;
    income += ov.totals.incomeKopeks;
    returns += ov.totals.returnsKopeks;
  }
  return { netKopeks: net, incomeKopeks: income, returnsKopeks: returns };
}

export async function calculateProfit(input: ProfitInput): Promise<ProfitResult> {
  const clubIds = input.clubId
    ? input.allowedClubIds.includes(input.clubId)
      ? [input.clubId]
      : []
    : input.allowedClubIds;

  const rev = await recognizedOfdRevenue(input.companyId, clubIds, input.months);
  const exp = await loadRecognizedExpenses({
    companyId: input.companyId,
    allowedClubIds: input.allowedClubIds,
    clubId: input.clubId ?? null,
    legalEntityId: input.legalEntityId ?? null,
    months: input.months,
    db: input.db,
  });

  return {
    revenueKopeks: rev.netKopeks,
    expenseKopeks: exp.totalKopeks,
    profitKopeks: rev.netKopeks - exp.totalKopeks,
    revenueBreakdown: { ofdNetKopeks: rev.netKopeks, ofdIncomeKopeks: rev.incomeKopeks, ofdReturnsKopeks: rev.returnsKopeks },
    expenseBreakdown: exp.bySourceType,
    warnings: exp.warnings,
    formulaVersion: PROFIT_FORMULA_VERSION,
  };
}
