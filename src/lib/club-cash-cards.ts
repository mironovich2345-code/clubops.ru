// Three summary cards for the Expenses page (Phase 2B UI), all for ONE selected
// Club. Derived from EXISTING realized sources — one place, no second conflicting
// formula, no invented balances. Integer kopeks only. Server-only.
//
// Card 1 «Остаток наличных ИП» — realized cash movements of the Club's single
//   active ИП: confirmed sales-report cash ИП (наличные ИП, "cash_ip") IN, minus
//   REALIZED expenses booked to that ИП (EXPENSE_REALIZED_STATUSES = confirmed +
//   verified) OUT. Each expense reduces it exactly once. Refunds carry no
//   legal-entity attribution in the current model, so they are not booked to a
//   specific ИП here (documented limitation — nothing is invented).
// Card 2 «Приход наличных по ИП вчера» — confirmed "cash_ip" for the previous
//   business calendar day (cash only, no expenses).
// Card 3 «Приход «Иное»» — confirmed Sales with the EXISTING source "Прочее"
//   (the equivalent of «Иное»; Sale has no cash/non-cash split, so this is all
//   payment methods) for the current business month.
import { prisma } from "@/lib/prisma";
import { EXPENSE_REALIZED_STATUSES } from "@/lib/budgets";

// Sales-report line key for наличные ИП (see lib/sales-report-rows SALES_REPORT_ROWS).
const CASH_IP_KEY = "cash_ip";
// Existing Sale.source equivalent of «Иное» (see lib/sales SALE_SOURCES).
const OTHER_INCOME_SOURCE = "Прочее";

export type ClubCashCards = {
  ip: { configured: boolean; multiple: boolean; balanceKopeks: number };
  yesterdayInflowKopeks: number;
  yesterdayDate: Date;
  otherIncomeMonthKopeks: number;
};

export async function getClubCashCards(clubId: string, now: Date = new Date()): Promise<ClubCashCards> {
  // The Club's single active ИП (config warning if none / more than one).
  const ipRows = await prisma.clubLegalEntity.findMany({
    where: { clubId, isActive: true, legalEntity: { isActive: true, type: { in: ["ip", "ИП"] } } },
    select: { legalEntityId: true },
  });
  const configured = ipRows.length === 1;
  const multiple = ipRows.length > 1;
  const ipId = configured ? ipRows[0].legalEntityId : null;

  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yEnd = dayStart;
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const [inflowRows, expenseOut, yInflowRows, otherIncome] = await Promise.all([
    // Card 1 inflow — all confirmed report cash ИП for this Club.
    ipId ? prisma.salesReportLine.findMany({ where: { key: CASH_IP_KEY, report: { clubId, status: "confirmed" } }, select: { amountKopeks: true } }) : Promise.resolve([]),
    // Card 1 outflow — realized expenses booked to the active ИП (once each).
    ipId ? prisma.expense.aggregate({ where: { clubId, legalEntityId: ipId, status: { in: [...EXPENSE_REALIZED_STATUSES] } }, _sum: { amountKopeks: true } }) : Promise.resolve({ _sum: { amountKopeks: 0 } }),
    // Card 2 — yesterday's confirmed cash ИП.
    prisma.salesReportLine.findMany({ where: { key: CASH_IP_KEY, report: { clubId, status: "confirmed", reportDate: { gte: yStart, lt: yEnd } } }, select: { amountKopeks: true } }),
    // Card 3 — confirmed «Прочее» sales for the current month.
    prisma.sale.aggregate({ where: { clubId, status: "confirmed", source: OTHER_INCOME_SOURCE, saleDate: { gte: mStart, lt: mEnd } }, _sum: { amountKopeks: true } }),
  ]);

  const inflow = inflowRows.reduce((s, r) => s + r.amountKopeks, 0);
  const balanceKopeks = ipId ? inflow - (expenseOut._sum.amountKopeks ?? 0) : 0;
  const yesterdayInflowKopeks = yInflowRows.reduce((s, r) => s + r.amountKopeks, 0);

  return {
    ip: { configured, multiple, balanceKopeks },
    yesterdayInflowKopeks,
    yesterdayDate: yStart,
    otherIncomeMonthKopeks: otherIncome._sum.amountKopeks ?? 0,
  };
}
