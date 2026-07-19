// Shared ОФД management overlay for the Dashboard and Analytics pages. Both screens
// historically showed 0 ₽ for Продажи АБ/ПТ because those come from confirmed
// SalesReport rows, which are empty for clubs that only have ОФД data. This helper
// projects the SAFE ОФД aggregates (OfdDailySalesSummary + OfdRevenueCategoryDaily-
// Summary) into per-club / per-scope revenue + category figures so the managerial
// screens reflect the real ОФД revenue. Pure math is separated from the loader for
// testability. NEVER reads raw fiscal payloads, cashier fields, fiscal signatures,
// or personal data — only safe pre-aggregated money + counts by club/category.
import { prisma } from "@/lib/prisma";

// --- Pure part -------------------------------------------------------------
export type OfdMgmtSalesDay = {
  clubId: string;
  date: string; // "YYYY-MM-DD"
  incomeTotalKopeks: number;
  incomeCashKopeks: number;
  incomeElectronicKopeks: number;
  returnTotalKopeks: number;
  netTotalKopeks: number;
  receiptCount: number;
};
export type OfdMgmtCategoryDay = {
  clubId: string;
  date: string; // "YYYY-MM-DD"
  categoryCode: string;
  incomeTotalKopeks: number;
};

export type OfdMgmtFigures = {
  incomeKopeks: number; // «Выручка ОФД» — приход (gross income)
  cashKopeks: number;
  cardKopeks: number; // безнал (electronic)
  returnsKopeks: number;
  netKopeks: number; // income − returns
  receipts: number;
  subscriptionsKopeks: number; // Абонементы (category membership)
  personalTrainingKopeks: number; // ПТ (category personal_training)
  groupTrainingKopeks: number; // Группы
  extraServicesKopeks: number; // Доп. услуги
  otherKopeks: number; // Иное
};

export type OfdManagementOverview = {
  perClub: Map<string, OfdMgmtFigures>;
  totals: OfdMgmtFigures;
  hasData: boolean;
};

export function emptyOfdMgmtFigures(): OfdMgmtFigures {
  return { incomeKopeks: 0, cashKopeks: 0, cardKopeks: 0, returnsKopeks: 0, netKopeks: 0, receipts: 0, subscriptionsKopeks: 0, personalTrainingKopeks: 0, groupTrainingKopeks: 0, extraServicesKopeks: 0, otherKopeks: 0 };
}

const CATEGORY_FIELD: Record<string, keyof OfdMgmtFigures> = {
  membership: "subscriptionsKopeks",
  personal_training: "personalTrainingKopeks",
  group_training: "groupTrainingKopeks",
  extra_services: "extraServicesKopeks",
  other: "otherKopeks",
};

// Half-open window [startStr, endStr): a day counts when startStr <= date < endStr
// (string compare is safe for zero-padded YYYY-MM-DD). Matches the analytics period.
const inWindow = (date: string, startStr: string, endStr: string) => date >= startStr && date < endStr;

export type OfdManagementInput = {
  summaries: OfdMgmtSalesDay[];
  categories: OfdMgmtCategoryDay[];
  startStr: string; // "YYYY-MM-DD" inclusive
  endStr: string; // "YYYY-MM-DD" exclusive
};

/** Build per-club + total ОФД management figures for a date window. Pure. */
export function buildOfdManagementOverview(input: OfdManagementInput): OfdManagementOverview {
  const { summaries, categories, startStr, endStr } = input;
  const perClub = new Map<string, OfdMgmtFigures>();
  const totals = emptyOfdMgmtFigures();
  const clubFor = (clubId: string) => {
    let f = perClub.get(clubId);
    if (!f) { f = emptyOfdMgmtFigures(); perClub.set(clubId, f); }
    return f;
  };

  for (const s of summaries) {
    if (!inWindow(s.date, startStr, endStr)) continue;
    const f = clubFor(s.clubId);
    f.incomeKopeks += s.incomeTotalKopeks;
    f.cashKopeks += s.incomeCashKopeks;
    f.cardKopeks += s.incomeElectronicKopeks;
    f.returnsKopeks += s.returnTotalKopeks;
    f.netKopeks += s.netTotalKopeks;
    f.receipts += s.receiptCount;
    totals.incomeKopeks += s.incomeTotalKopeks;
    totals.cashKopeks += s.incomeCashKopeks;
    totals.cardKopeks += s.incomeElectronicKopeks;
    totals.returnsKopeks += s.returnTotalKopeks;
    totals.netKopeks += s.netTotalKopeks;
    totals.receipts += s.receiptCount;
  }

  for (const c of categories) {
    if (!inWindow(c.date, startStr, endStr)) continue;
    const field = CATEGORY_FIELD[c.categoryCode];
    if (!field) continue;
    clubFor(c.clubId)[field] += c.incomeTotalKopeks;
    totals[field] += c.incomeTotalKopeks;
  }

  const hasData = totals.incomeKopeks > 0 || totals.returnsKopeks > 0 || totals.receipts > 0;
  return { perClub, totals, hasData };
}

/** Result = ОФД net revenue − confirmed costs. Pure; pending costs never included. */
export function computeManagementResult(ofdNetKopeks: number, confirmedCostsKopeks: number): number {
  return ofdNetKopeks - confirmedCostsKopeks;
}

// Flat projection of one club's ОФД figures for the dashboard ClubCard. Keeps the
// card construction identical in both dashboard code paths (inline + loader).
export type OfdCardFields = {
  ofdHasData: boolean;
  ofdRevenueKopeks: number;
  ofdNetKopeks: number;
  ofdReturnsKopeks: number;
  ofdReceipts: number;
  ofdSubscriptionsKopeks: number;
  ofdPersonalTrainingKopeks: number;
  ofdGroupTrainingKopeks: number;
  ofdExtraServicesKopeks: number;
  ofdOtherKopeks: number;
};
export function ofdCardFields(f?: OfdMgmtFigures): OfdCardFields {
  const g = f ?? emptyOfdMgmtFigures();
  return {
    ofdHasData: g.incomeKopeks > 0 || g.returnsKopeks > 0 || g.receipts > 0,
    ofdRevenueKopeks: g.incomeKopeks,
    ofdNetKopeks: g.netKopeks,
    ofdReturnsKopeks: g.returnsKopeks,
    ofdReceipts: g.receipts,
    ofdSubscriptionsKopeks: g.subscriptionsKopeks,
    ofdPersonalTrainingKopeks: g.personalTrainingKopeks,
    ofdGroupTrainingKopeks: g.groupTrainingKopeks,
    ofdExtraServicesKopeks: g.extraServicesKopeks,
    ofdOtherKopeks: g.otherKopeks,
  };
}

// --- Loader ----------------------------------------------------------------
function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Load the ОФД management overview for a scope + date window [start, end). Scoped
 * by companyId + clubIds (never widens). Returns empty overview for an empty scope. */
export async function loadOfdManagementOverview(companyId: string, clubIds: string[], start: Date, end: Date): Promise<OfdManagementOverview> {
  const startStr = ymdLocal(start);
  const endStr = ymdLocal(end);
  if (clubIds.length === 0) return buildOfdManagementOverview({ summaries: [], categories: [], startStr, endStr });

  const [summaries, categories] = await Promise.all([
    prisma.ofdDailySalesSummary.findMany({
      where: { companyId, provider: "taxcom", clubId: { in: clubIds }, date: { gte: startStr, lt: endStr } },
      select: { clubId: true, date: true, incomeTotalKopeks: true, incomeCashKopeks: true, incomeElectronicKopeks: true, returnTotalKopeks: true, netTotalKopeks: true, receiptCount: true },
    }),
    prisma.ofdRevenueCategoryDailySummary.findMany({
      where: { companyId, provider: "taxcom", clubId: { in: clubIds }, date: { gte: startStr, lt: endStr } },
      select: { clubId: true, date: true, categoryCode: true, incomeTotalKopeks: true },
    }),
  ]);

  return buildOfdManagementOverview({ summaries, categories, startStr, endStr });
}
