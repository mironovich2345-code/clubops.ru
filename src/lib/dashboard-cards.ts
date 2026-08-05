// Per-Company Dashboard club-card loader. Runs the existing scoped analytics +
// balance + obligation loaders ONCE for a single Company and its club ids, then
// shapes the per-club cards in memory. Strategic (multi-Company) dashboards call
// this once per filtered Company and concatenate — never mixing one Company's
// data into another's scope, and never looping per club.
import { loadAnalyticsData, buildAnalyticsReport, type ResolvedPeriod } from "@/lib/analytics";
import { getLatestBalancesByClub } from "@/lib/balance-snapshots";
import { loadPaymentObligationsForScope } from "@/lib/payment-obligations";
import { calculateBalanceForecast, balanceRiskLevel } from "@/lib/balance";
import { dayStart, addDays } from "@/lib/payments";
import { loadOfdManagementOverview, ofdCardFields, type OfdCardFields } from "@/lib/analytics/ofd-management";
import { loadClubCashBalances } from "@/lib/cash-collections";
import { loadRecognizedExpenses } from "@/lib/finance/recognized-expense";

export type ClubCard = {
  id: string;
  name: string;
  city: string;
  companyId: string;
  companyName: string;
  subsFact: number;
  subsPlan: number;
  subsPct: number | null;
  ptFact: number;
  ptPlan: number;
  ptPct: number | null;
  expensesKopeks: number;
  // REM-05A — canonical recognized expenses (accrual: payroll + partially_paid full +
  // refunds + taxes) per club, so the club-card "Результат" = OFD net − recognized =
  // the ONE official profit (calculateProfit for that club). Distinct from the
  // operational "Фактические расходы" (expensesKopeks) line.
  recognizedExpensesKopeks: number;
  breakEvenKopeks: number;
  oooKopeks: number | null;
  ipKopeks: number | null;
  oooRisk: "low" | "high" | "unknown";
  ipRisk: "low" | "high" | "unknown";
  // Current ООО / ИП fact cash (loadClubCashBalances) — shown on the club card.
  oooFactKopeks: number;
  ipFactKopeks: number;
  ofd: OfdCardFields;
};

export type CardClubInput = { id: string; name: string; city: string };

/**
 * Build club cards for ONE company. Balances are taken as of the END of the
 * selected month (period.end); cash-gap risk uses the next-30-day obligations
 * (real-time, current) per legal entity, kept ООО/ИП separate.
 */
export async function loadCompanyClubCards(
  companyId: string,
  companyName: string,
  clubs: CardClubInput[],
  period: ResolvedPeriod,
  financials: boolean,
  now: Date,
  showOfd: boolean = false,
  showCash: boolean = false,
): Promise<ClubCard[]> {
  if (clubs.length === 0) return [];
  const clubIds = clubs.map((c) => c.id);

  const data = await loadAnalyticsData(companyId, clubIds, period);
  const report = buildAnalyticsReport(data, period, "day");
  // ОФД management overlay (owner/GD/regional): real per-club revenue by category.
  const ofdMgmt = showOfd ? await loadOfdManagementOverview(companyId, clubIds, period.start, period.end) : null;
  // Current ООО / ИП fact cash per club (loadClubCashBalances — unchanged math).
  const factCash = new Map<string, { ooo: number; ip: number }>();
  if (showCash) {
    const per = await Promise.all(clubIds.map((id) => loadClubCashBalances(companyId, id, now)));
    clubIds.forEach((id, i) => factCash.set(id, { ooo: per[i].balances.cashOooFactBalance, ip: per[i].balances.cashIpFactBalance }));
  }

  const expensesByClub = new Map(report.clubRanking.map((r) => [r.clubId, r.expensesKopeks]));
  // REM-05A — ONE scoped recognized-expense query for all clubs (byClub breakdown);
  // no per-club service call, no N+1. Powers the canonical club-card "Результат".
  const recognized = showOfd || financials
    ? await loadRecognizedExpenses({ companyId, allowedClubIds: clubIds, months: period.months, includeBreakdown: false })
    : null;
  const splitByClub = new Map(report.planSplitByClub.map((r) => [r.clubId, r]));
  const budgetByClub = new Map<string, number>();
  for (const b of data.budgets) budgetByClub.set(b.clubId, (budgetByClub.get(b.clubId) ?? 0) + b.limitAmountKopeks);

  const balancesByClub = financials ? await getLatestBalancesByClub(companyId, clubIds, period.end) : new Map();

  const oblByClub = new Map<string, { ooo: number; ip: number }>();
  if (financials) {
    const horizon = addDays(dayStart(now), 30);
    const { obligations } = await loadPaymentObligationsForScope({ companyId, clubIds, loadEnd: horizon });
    for (const o of obligations) {
      if (!o.dueDate || dayStart(o.dueDate) > horizon) continue;
      const row = oblByClub.get(o.clubId) ?? { ooo: 0, ip: 0 };
      if (o.legalEntityType === "ooo") row.ooo += o.amountKopeks;
      else if (o.legalEntityType === "ip") row.ip += o.amountKopeks;
      oblByClub.set(o.clubId, row);
    }
  }

  const riskFor = (balanceKopeks: number | null, obligationsKopeks: number) =>
    balanceRiskLevel(calculateBalanceForecast({ currentCashKopeks: balanceKopeks, obligationsKopeks }));

  return clubs.map((c) => {
    const split = splitByClub.get(c.id);
    const bal = balancesByClub.get(c.id);
    const oooKopeks = bal?.oooKopeks ?? null;
    const ipKopeks = bal?.ipKopeks ?? null;
    const obl = oblByClub.get(c.id) ?? { ooo: 0, ip: 0 };
    return {
      id: c.id,
      name: c.name,
      city: c.city,
      companyId,
      companyName,
      subsFact: split?.subscriptions.factKopeks ?? 0,
      subsPlan: split?.subscriptions.planKopeks ?? 0,
      subsPct: split?.subscriptions.percent ?? null,
      ptFact: split?.personal_training.factKopeks ?? 0,
      ptPlan: split?.personal_training.planKopeks ?? 0,
      ptPct: split?.personal_training.percent ?? null,
      expensesKopeks: expensesByClub.get(c.id) ?? 0,
      recognizedExpensesKopeks: recognized?.byClub[c.id] ?? 0,
      breakEvenKopeks: budgetByClub.get(c.id) ?? 0,
      oooKopeks,
      ipKopeks,
      oooRisk: riskFor(oooKopeks, obl.ooo),
      ipRisk: riskFor(ipKopeks, obl.ip),
      oooFactKopeks: factCash.get(c.id)?.ooo ?? 0,
      ipFactKopeks: factCash.get(c.id)?.ip ?? 0,
      ofd: ofdCardFields(ofdMgmt?.perClub.get(c.id)),
    };
  });
}
