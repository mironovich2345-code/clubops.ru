// Three summary cards for the Expenses page, for ONE selected Club, sourced from
// the cash-wallet ledger (lib/cash-wallets — the single source of cash truth).
// Integer kopeks. Server-only.
//
// Card 1 «Остаток наличных ИП …» — club_cash wallet balance (manager view) or
//   club + authorized regional wallets (strategic/accounting view). Balances come
//   ONLY from confirmed CashMovement.
// Card 2 «Приход наличных по ИП вчера» — OFD cash income for the previous business
//   day. TEMPORARY pre-OFD adapter: until OFD is integrated we project the
//   existing confirmed sales-report "cash_ip" for that day (documented; kept
//   SEPARATE from other_cash_income).
// Card 3 «Приход «Иное»» — confirmed other_cash_income into the Club wallet for
//   the current business month (NOT Sales, NOT revenue).
import { prisma } from "@/lib/prisma";
import { getClubCashBreakdown, otherIncomeForClub } from "@/lib/cash-wallets";

// Temporary pre-OFD source: наличные ИП line of a confirmed sales report.
const CASH_IP_KEY = "cash_ip";

export type ClubCashCards = {
  ip: { configured: boolean; multiple: boolean; legalEntityId: string | null };
  clubBalanceKopeks: number;
  regionalTotalKopeks: number;
  combinedKopeks: number;
  transferredToRegionalTotalKopeks: number;
  hasOpeningBalance: boolean;
  yesterdayOfdKopeks: number; // temporary cash_ip adapter
  yesterdayDate: Date;
  otherIncomeMonthKopeks: number;
};

export async function getClubCashCards(clubId: string, now: Date = new Date()): Promise<ClubCashCards> {
  const ipRows = await prisma.clubLegalEntity.findMany({
    where: { clubId, isActive: true, legalEntity: { isActive: true, type: { in: ["ip", "ИП"] } } },
    select: { legalEntityId: true },
  });
  const configured = ipRows.length === 1;
  const multiple = ipRows.length > 1;
  const ipId = configured ? ipRows[0].legalEntityId : null;

  const yStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  if (!ipId) {
    return {
      ip: { configured, multiple, legalEntityId: null },
      clubBalanceKopeks: 0, regionalTotalKopeks: 0, combinedKopeks: 0, transferredToRegionalTotalKopeks: 0,
      hasOpeningBalance: false, yesterdayOfdKopeks: 0, yesterdayDate: yStart, otherIncomeMonthKopeks: 0,
    };
  }

  const [breakdown, otherIncomeMonthKopeks, yInflowRows] = await Promise.all([
    getClubCashBreakdown(clubId, ipId),
    otherIncomeForClub(clubId, ipId, mStart, mEnd),
    // Card 2 temporary adapter — confirmed наличные ИП for the previous day.
    prisma.salesReportLine.findMany({ where: { key: CASH_IP_KEY, report: { clubId, status: "confirmed", reportDate: { gte: yStart, lt: yEnd } } }, select: { amountKopeks: true } }),
  ]);

  return {
    ip: { configured, multiple, legalEntityId: ipId },
    clubBalanceKopeks: breakdown.clubBalanceKopeks,
    regionalTotalKopeks: breakdown.regionalTotalKopeks,
    combinedKopeks: breakdown.combinedKopeks,
    transferredToRegionalTotalKopeks: breakdown.transferredToRegionalTotalKopeks,
    hasOpeningBalance: breakdown.hasOpeningBalance,
    yesterdayOfdKopeks: yInflowRows.reduce((s, r) => s + r.amountKopeks, 0),
    yesterdayDate: yStart,
    otherIncomeMonthKopeks,
  };
}
