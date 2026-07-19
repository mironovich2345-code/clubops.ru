import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getCurrentAccessContext,
  getUserClubs,
} from "@/lib/access";
import { canManageSalesPlans, canApproveMonthReopen, canAnyRoleAccessPage, isStrategicRole, type Role } from "@/lib/auth";
import { resolveStrategicScope } from "@/lib/strategic-scope";
import { loadCompanyClubCards } from "@/lib/dashboard-cards";
import { getUnconfirmedReportsForScope } from "@/lib/sales-reports";
import { getPendingReopenRequestsForCompanies } from "@/lib/month-reopen";
import { StrategicScopeFilter } from "./_components/StrategicScopeFilter";
import { CashScopeSummary } from "./_components/CashScopeSummary";
import { OfdSalesOverview } from "./_components/OfdSalesOverview";
import { loadOfdManagementOverview, ofdCardFields, computeManagementResult, type OfdCardFields } from "@/lib/analytics/ofd-management";
import { openInStrategicScope } from "./strategic-actions";
import {
  loadAnalyticsData,
  buildAnalyticsReport,
  resolveMonthPeriod,
} from "@/lib/analytics";
import { buildMonthlyForecast } from "@/lib/forecast";
import {
  getSalesPlansForCompanyMonth,
  monthKey,
  normalizeMonth,
} from "@/lib/sales-plans";
import { getLatestBalancesByClub, type ClubBalances } from "@/lib/balance-snapshots";
import { getPendingReopenRequestsForCompany } from "@/lib/month-reopen";
import { getUnconfirmedReportsForMonth } from "@/lib/sales-reports";
import { loadPaymentObligationsForScope } from "@/lib/payment-obligations";
import { calculateBalanceForecast, balanceRiskLevel } from "@/lib/balance";
import { dayStart, addDays } from "@/lib/payments";
import { SalesPlanForm } from "./_components/SalesPlanForm";
import { SalesPlanImport } from "./_components/SalesPlanImport";
import { OwnerReopenApprovals, type ReopenRow } from "./_components/OwnerReopenApprovals";
import { DashboardMonthSelector } from "./_components/DashboardMonthSelector";
import { UnconfirmedSalesBlock } from "./_components/UnconfirmedSalesBlock";
import { DashboardForecast } from "./_components/DashboardForecast";
import { openClubAnalytics } from "./actions";

export const dynamic = "force-dynamic";

const monthFormatter = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });

// Financial fields on a club card (Расходы, Окупаемость) are for owner /
// general_director / regional_director / accountant only. Managers (sales-only)
// and marketers see the sales-only card. Page access itself is unchanged.
const FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "accountant"]);

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

function planTone(pct: number | null): string {
  if (pct === null) return "bg-slate-300 dark:bg-slate-700";
  if (pct >= 100) return "bg-emerald-500";
  if (pct >= 80) return "bg-amber-500";
  return "bg-rose-500";
}

type ClubCard = {
  id: string;
  name: string;
  city: string;
  subsFact: number;
  subsPlan: number;
  subsPct: number | null;
  ptFact: number;
  ptPlan: number;
  ptPct: number | null;
  expensesKopeks: number;
  breakEvenKopeks: number;
  // Finance Control — real ООО/ИП balances + SEPARATE per-entity cash-gap risk.
  oooKopeks: number | null;
  ipKopeks: number | null;
  oooRisk: "low" | "high" | "unknown";
  ipRisk: "low" | "high" | "unknown";
  companyName?: string; // shown on cards in the multi-Company strategic view
  // ОФД management overlay (owner/GD/regional): real revenue by category so the
  // cards are not stuck at 0 ₽ when only ОФД data exists.
  ofd: OfdCardFields;
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    month?: string;
    closeMonth?: string;
    scopeMode?: string;
    companyId?: string;
    city?: string;
    clubId?: string;
  }>;
}) {
  const user = await requirePageAccess("dashboard");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Дашборд" description="Обзор клубов" />;
  }
  const companyId = scope.company.id;
  const companyName = scope.company.name;

  const ctx = await getCurrentAccessContext();
  const roles = ctx?.effectiveRoles ?? [];
  const financials = roles.some((r) => FINANCIAL_ROLES.has(r));
  const canEditPlan = canManageSalesPlans(roles);
  const canViewSales = canAnyRoleAccessPage(roles, "sales");
  const canApproveReopen = canApproveMonthReopen(roles);
  // Cash fact balances are a finance/operational surface: shown to any role that can
  // reach Инкассация (/collections) — owner/GD/regional/manager. A marketer has
  // dashboard+analytics only and must NOT see ООО/ИП cash, so gate on that access.
  const canSeeCash = canAnyRoleAccessPage(roles, "collections");
  // Managerial ОФД-продажи overview: owner / general_director / regional_director
  // (the ofd_sales page-access grant). Manager / accountant / marketer never see it.
  const canSeeOfdSales = canAnyRoleAccessPage(roles, "ofd_sales");

  const now = new Date();

  // --- Selected analytical month (?month=YYYY-MM, validated; fallback current) ---
  const sp = await searchParams;
  const monthParam = sp.month;
  const currentMonth = monthKey(now);
  const selectedMonth = normalizeMonth(monthParam ?? "") ?? currentMonth;
  const period = resolveMonthPeriod(selectedMonth, now);
  const monthLabel = capitalize(monthFormatter.format(period.start));
  const isCurrentMonth = selectedMonth === currentMonth;
  // Adjacent months for the selector (local-time arithmetic — no UTC drift).
  const prevMonth = monthKey(new Date(period.start.getFullYear(), period.start.getMonth() - 1, 1));
  const nextMonth = monthKey(new Date(period.start.getFullYear(), period.start.getMonth() + 1, 1));
  // Month phase relative to today drives forecast labeling.
  const monthMode: "past" | "current" | "future" =
    now.getTime() >= period.end.getTime() ? "past" : now.getTime() < period.start.getTime() ? "future" : "current";

  // ===== Strategic (owner / general director): multi-Company read-only view =====
  if (isStrategicRole(roles) && ctx) {
    const strategic = await resolveStrategicScope(ctx, {
      scopeMode: sp.scopeMode,
      companyId: sp.companyId,
      city: sp.city,
      clubId: sp.clubId,
    });
    const multiCompany = strategic.filteredCompanyIds.length > 1;
    const daysInSel = new Date(period.start.getFullYear(), period.start.getMonth() + 1, 0).getDate();
    const daysLeft = monthMode === "past" ? 0 : monthMode === "future" ? daysInSel : daysInSel - now.getDate() + 1;

    // Group filtered clubs by company → ONE scoped loader per company (no N+1).
    const byCompany = new Map<string, { name: string; clubs: { id: string; name: string; city: string }[] }>();
    for (const c of strategic.filteredClubs) {
      const g = byCompany.get(c.companyId) ?? { name: c.companyName, clubs: [] };
      g.clubs.push({ id: c.id, name: c.name, city: c.city });
      byCompany.set(c.companyId, g);
    }
    const cardGroups = await Promise.all(
      [...byCompany.entries()].map(([cid, g]) => loadCompanyClubCards(cid, g.name, g.clubs, period, financials, now, canSeeOfdSales)),
    );
    const cards = cardGroups
      .flat()
      .sort(
        (a, b) =>
          a.companyName.localeCompare(b.companyName, "ru") ||
          a.city.localeCompare(b.city, "ru") ||
          a.name.localeCompare(b.name, "ru"),
      );

    // Plan management (GD) stays on the cookie-selected company — an operational
    // surface, not part of the read-only cross-Company aggregation.
    const planClubs = canEditPlan ? (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name })) : [];

    const filteredClubIds = strategic.filteredClubs.map((c) => c.id);
    const unconfirmed = await getUnconfirmedReportsForScope(strategic.filteredCompanyIds, filteredClubIds, selectedMonth);
    const unconfirmedTotalKopeks = unconfirmed.reduce((sum, r) => sum + r.totalKopeks, 0);
    const unconfirmedClubs = new Set(unconfirmed.map((r) => r.clubId)).size;
    const oldest = unconfirmed[0] ?? null;
    const oldestAge = oldest
      ? Math.max(0, Math.floor((dayStart(now).getTime() - dayStart(oldest.createdAt).getTime()) / 86_400_000))
      : null;

    const companyNameById = new Map(strategic.accessibleCompanies.map((c) => [c.id, c.name]));
    const strategicReopenRows: ReopenRow[] = canApproveReopen
      ? (await getPendingReopenRequestsForCompanies(strategic.filteredCompanyIds)).map((r) => ({
          id: r.id,
          month: r.month,
          monthLabel: capitalize(monthFormatter.format(new Date(`${r.month}-01T00:00:00`))),
          reason: r.reason,
          requestedByName: r.requestedByName,
          requestedAt: r.requestedAt.toISOString(),
          clubName: r.clubName,
          companyName: companyNameById.get(r.companyId) ?? "—",
        }))
      : [];

    const scopeHeading = strategic.selectedCompanyId
      ? companyNameById.get(strategic.selectedCompanyId) ?? "Сеть"
      : "Все доступные сети";

    return (
      <div className="mx-auto max-w-[1440px]">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <PageHeader title="Дашборд" description={scopeHeading} />
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Сетей: {strategic.filteredCompanyIds.length} · Клубов: {strategic.filteredClubs.length}
              {strategic.selectedCity ? ` · Город: ${strategic.selectedCity}` : ""} · {monthLabel}
            </div>
          </div>
          <DashboardMonthSelector monthLabel={monthLabel} prevMonth={prevMonth} nextMonth={nextMonth} isCurrent={isCurrentMonth} />
        </div>

        {strategic.accessibleClubs.length > 0 ? (
          <StrategicScopeFilter
            companies={strategic.accessibleCompanies}
            clubs={strategic.accessibleClubs}
            mode={strategic.mode}
            companyId={strategic.selectedCompanyId}
            city={strategic.selectedCity}
            clubId={strategic.selectedClubId}
            month={selectedMonth}
          />
        ) : null}

        {/* Cash fact balances (single company in scope) — ООО/ИП + review counters. */}
        {canSeeCash && strategic.filteredCompanyIds.length === 1 ? (
          <CashScopeSummary companyId={strategic.filteredCompanyIds[0]} clubIds={filteredClubIds} showPending={financials} />
        ) : null}

        {/* ОФД-продажи overview (single company in scope) — owner / GD. */}
        {canSeeOfdSales && strategic.filteredCompanyIds.length === 1 ? (
          <OfdSalesOverview companyId={strategic.filteredCompanyIds[0]} clubIds={filteredClubIds} />
        ) : null}

        {/* Priority: approvals, then unconfirmed sales, then club cards. */}
        {canApproveReopen ? <OwnerReopenApprovals requests={strategicReopenRows} /> : null}

        {canViewSales ? (
          <UnconfirmedSalesBlock
            rows={unconfirmed.slice(0, 5).map((r) => ({
              id: r.id,
              companyId: r.companyId,
              companyName: r.companyName,
              clubId: r.clubId,
              clubName: r.clubName,
              reportDate: r.reportDate.toISOString(),
              createdAt: r.createdAt.toISOString(),
              managerName: r.managerName,
              createdByName: r.createdByName,
              totalKopeks: r.totalKopeks,
              oooKopeks: r.oooKopeks,
              ipKopeks: r.ipKopeks,
            }))}
            count={unconfirmed.length}
            totalKopeks={unconfirmedTotalKopeks}
            clubsAffected={unconfirmedClubs}
            oldestDate={oldest ? oldest.reportDate.toISOString() : null}
            oldestAgeDays={oldestAge}
            monthLabel={monthLabel}
            showCompany={multiCompany}
            safeOpenAction={openInStrategicScope}
          />
        ) : null}

        {strategic.accessibleClubs.length === 0 ? (
          <div className={`px-4 py-16 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
            Нет доступных сетей или клубов
          </div>
        ) : cards.length === 0 ? (
          <div className={`px-4 py-16 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
            Нет клубов по выбранным фильтрам
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {cards.map((c) => (
              <ClubOverviewCard key={c.id} card={c} financials={financials} showOfd={canSeeOfdSales} daysLeft={daysLeft} showCompany={multiCompany} />
            ))}
          </div>
        )}

        {canEditPlan ? (
          <ManagementSection
            companyId={companyId}
            canEditPlan={canEditPlan}
            clubs={planClubs}
            defaultClubId={planClubs[0]?.id ?? ""}
            searchParams={sp}
            now={now}
          />
        ) : null}
      </div>
    );
  }

  // Owner-only: pending month-reopening requests to approve/reject.
  const reopenRows: ReopenRow[] = canApproveReopen
    ? (await getPendingReopenRequestsForCompany(companyId)).map((r) => ({
        id: r.id,
        month: r.month,
        monthLabel: capitalize(monthFormatter.format(new Date(`${r.month}-01T00:00:00`))),
        reason: r.reason,
        requestedByName: r.requestedByName,
        requestedAt: r.requestedAt.toISOString(),
        clubName: r.clubName,
        companyName,
      }))
    : [];

  // Club list = every active club accessible to the user in this company,
  // regardless of the topbar's selected club. getUserClubs is the role-correct
  // scope: owner/GD -> all company clubs; regional -> assigned; manager -> own.
  const clubs = await getUserClubs(user.id, companyId);
  const clubIds = clubs.map((c) => c.id);
  const scopeForReports = { company: { id: companyId, name: companyName }, club: null, clubIds };

  // Per-club figures reuse the SAME source of truth as Analytics, for the
  // SELECTED month, so the cards match the Analytics page exactly.
  const data = await loadAnalyticsData(companyId, clubIds, period);
  const report = buildAnalyticsReport(data, period, "day");

  // Unconfirmed (pending_accountant) sales reports for the selected month, scoped.
  // Shown to dashboard viewers who may see sales (not marketer); read-only.
  const unconfirmed = canViewSales ? await getUnconfirmedReportsForMonth(scopeForReports, selectedMonth) : [];
  const unconfirmedTotalKopeks = unconfirmed.reduce((s, r) => s + r.totalKopeks, 0);
  const unconfirmedClubs = new Set(unconfirmed.map((r) => r.clubId)).size;
  const oldestUnconfirmed = unconfirmed[0] ?? null; // ordered reportDate asc
  const oldestAgeDays = oldestUnconfirmed
    ? Math.max(0, Math.floor((dayStart(now).getTime() - dayStart(oldestUnconfirmed.createdAt).getTime()) / 86_400_000))
    : null;

  // --- Company-level sales forecast for the selected month (NaN/Infinity-safe) ---
  const s = report.summary;
  const abFact = s.subscriptionsKopeks;
  const ptFact = s.personalTrainingKopeks;
  const abPlan = report.planTotals.subscriptions.planKopeks;
  const ptPlan = report.planTotals.personal_training.planKopeks;
  const salesPlan = s.planTargetKopeks > 0 ? s.planTargetKopeks : abPlan + ptPlan;
  // Previous-month pacing only applies to the live current month.
  let previousMonthRemainingSales: number | null = null;
  if (period.key === "current_month") {
    const prevRows = data.reportSplit.filter((r) => r.date >= period.prevStart && r.date < period.prevEnd);
    if (prevRows.length > 0) {
      const cutoffDay = now.getDate();
      previousMonthRemainingSales = prevRows
        .filter((r) => r.date.getDate() >= cutoffDay)
        .reduce((acc, r) => acc + r.subscriptions + r.personal_training, 0);
    }
  }
  const forecast = buildMonthlyForecast({
    salesFact: abFact + ptFact,
    salesPlan,
    expenseBudget: s.budgetTotalKopeks,
    periodStart: period.start,
    periodEnd: period.end,
    now,
    previousMonthRemainingSales,
  });

  const expensesByClub = new Map(report.clubRanking.map((r) => [r.clubId, r.expensesKopeks]));
  const splitByClub = new Map(report.planSplitByClub.map((r) => [r.clubId, r]));
  const budgetByClub = new Map<string, number>();
  for (const b of data.budgets) budgetByClub.set(b.clubId, (budgetByClub.get(b.clubId) ?? 0) + b.limitAmountKopeks);

  // Finance Control — per-club ООО/ИП balances as of the END of the selected
  // month (latest snapshot at or before month end; never falls forward), plus
  // SEPARATE per-entity cash-gap risk (30-day obligations; never merged).
  const balancesByClub: Map<string, ClubBalances> = financials
    ? await getLatestBalancesByClub(companyId, clubIds, period.end)
    : new Map();
  const oblByClub = new Map<string, { ooo: number; ip: number }>();
  if (financials) {
    const t0 = dayStart(now);
    const horizon = addDays(t0, 30);
    const { obligations: payObs } = await loadPaymentObligationsForScope({ companyId, clubIds, loadEnd: horizon });
    for (const o of payObs) {
      if (!o.dueDate || dayStart(o.dueDate) > horizon) continue;
      const row = oblByClub.get(o.clubId) ?? { ooo: 0, ip: 0 };
      if (o.legalEntityType === "ooo") row.ooo += o.amountKopeks;
      else if (o.legalEntityType === "ip") row.ip += o.amountKopeks;
      oblByClub.set(o.clubId, row);
    }
  }
  const riskFor = (balanceKopeks: number | null, obligationsKopeks: number) =>
    balanceRiskLevel(calculateBalanceForecast({ currentCashKopeks: balanceKopeks, obligationsKopeks }));

  // ОФД management overlay (owner/GD/regional): real per-club revenue by category for
  // the selected period, so the cards reflect ОФД instead of showing 0 ₽.
  const ofdMgmt = canSeeOfdSales
    ? await loadOfdManagementOverview(companyId, clubIds, period.start, period.end)
    : null;

  const cards: ClubCard[] = clubs.map((c) => {
    const split = splitByClub.get(c.id);
    const bal = balancesByClub.get(c.id);
    const oooKopeks = bal?.oooKopeks ?? null;
    const ipKopeks = bal?.ipKopeks ?? null;
    const obl = oblByClub.get(c.id) ?? { ooo: 0, ip: 0 };
    const oooRisk = riskFor(oooKopeks, obl.ooo);
    const ipRisk = riskFor(ipKopeks, obl.ip);
    return {
      id: c.id,
      name: c.name,
      city: c.city,
      subsFact: split?.subscriptions.factKopeks ?? 0,
      subsPlan: split?.subscriptions.planKopeks ?? 0,
      subsPct: split?.subscriptions.percent ?? null,
      ptFact: split?.personal_training.factKopeks ?? 0,
      ptPlan: split?.personal_training.planKopeks ?? 0,
      ptPct: split?.personal_training.percent ?? null,
      expensesKopeks: expensesByClub.get(c.id) ?? 0,
      breakEvenKopeks: budgetByClub.get(c.id) ?? 0,
      oooKopeks,
      ipKopeks,
      oooRisk,
      ipRisk,
      ofd: ofdCardFields(ofdMgmt?.perClub.get(c.id)),
    };
  });

  // Days left in the SELECTED month (forecast helper: 0 for past, full for
  // future, remaining-incl-today for the live month).
  const daysLeft = forecast.daysLeft;

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <PageHeader title="Дашборд" description="Обзор клубов" />
        <DashboardMonthSelector monthLabel={monthLabel} prevMonth={prevMonth} nextMonth={nextMonth} isCurrent={isCurrentMonth} />
      </div>

      {/* Cash fact balances — operational for everyone in scope who can reach
          Инкассация; review counters only for financial roles (a plain manager sees
          balances, not counters). Marketer (analytics-only) never sees cash. */}
      {canSeeCash ? <CashScopeSummary companyId={companyId} clubIds={clubIds} showPending={financials} /> : null}

      {/* ОФД-продажи overview — owner / GD / regional_director (ofd_sales access),
          scoped to their clubs. Manager / accountant / marketer never see it. */}
      {canSeeOfdSales ? <OfdSalesOverview companyId={companyId} clubIds={clubIds} /> : null}

      {/* Priority order: critical approvals, then unconfirmed sales, then forecast + clubs. */}
      {canApproveReopen ? <OwnerReopenApprovals requests={reopenRows} /> : null}

      {canViewSales ? (
        <UnconfirmedSalesBlock
          rows={unconfirmed.slice(0, 5).map((r) => ({
            id: r.id,
            companyId: r.companyId,
            companyName: r.companyName,
            clubId: r.clubId,
            clubName: r.clubName,
            reportDate: r.reportDate.toISOString(),
            createdAt: r.createdAt.toISOString(),
            managerName: r.managerName,
            createdByName: r.createdByName,
            totalKopeks: r.totalKopeks,
            oooKopeks: r.oooKopeks,
            ipKopeks: r.ipKopeks,
          }))}
          count={unconfirmed.length}
          totalKopeks={unconfirmedTotalKopeks}
          clubsAffected={unconfirmedClubs}
          oldestDate={oldestUnconfirmed ? oldestUnconfirmed.reportDate.toISOString() : null}
          oldestAgeDays={oldestAgeDays}
          monthLabel={monthLabel}
        />
      ) : null}

      <DashboardForecast mode={monthMode} monthLabel={monthLabel} forecast={forecast} abFact={abFact} ptFact={ptFact} abPlan={abPlan} ptPlan={ptPlan} />

      {cards.length === 0 ? (
        <div className={`px-4 py-16 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
          Нет доступных клубов
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {cards.map((c) => (
            <ClubOverviewCard key={c.id} card={c} financials={financials} showOfd={canSeeOfdSales} daysLeft={daysLeft} />
          ))}
        </div>
      )}

      {/* Sales-plan management (general director). Month close / reopen no longer
          lives on the dashboard — it moved to the Chief Accountant workspace and
          the Owner approval block above. */}
      {canEditPlan ? (
        <ManagementSection
          companyId={companyId}
          canEditPlan={canEditPlan}
          clubs={clubs.map((c) => ({ id: c.id, name: c.name }))}
          defaultClubId={scope.club?.id ?? clubs[0]?.id ?? ""}
          searchParams={sp}
          now={now}
        />
      ) : null}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- club overview card ----------------------------------------------------

type DailyTarget = { kind: "value"; perDayKopeks: number } | { kind: "done" } | { kind: "noplan" };

function dailyTarget(plan: number, fact: number, daysLeft: number): DailyTarget {
  if (plan <= 0) return { kind: "noplan" };
  const remaining = plan - fact;
  if (remaining <= 0) return { kind: "done" };
  if (daysLeft <= 0) return { kind: "value", perDayKopeks: remaining };
  return { kind: "value", perDayKopeks: Math.round(remaining / daysLeft) };
}

function dailyTargetLabel(t: DailyTarget): { text: string; cls: string } {
  if (t.kind === "noplan") return { text: "План не задан", cls: "text-slate-400 dark:text-slate-500" };
  if (t.kind === "done") return { text: "План выполнен", cls: "text-emerald-600 dark:text-emerald-400" };
  return { text: `${formatKopeks(t.perDayKopeks)} / день`, cls: "text-slate-700 dark:text-slate-200" };
}

function ClubOverviewCard({ card, financials, showOfd, daysLeft, showCompany = false }: { card: ClubCard; financials: boolean; showOfd: boolean; daysLeft: number; showCompany?: boolean }) {
  // Owner/GD/regional with ОФД data see the real ОФД revenue by category; other
  // roles / clubs without ОФД keep the confirmed-report figures (may be 0).
  const useOfd = showOfd && card.ofd.ofdHasData;
  const subsFact = useOfd ? card.ofd.ofdSubscriptionsKopeks : card.subsFact;
  const ptFact = useOfd ? card.ofd.ofdPersonalTrainingKopeks : card.ptFact;
  const subsPct = useOfd ? (card.subsPlan > 0 ? (subsFact / card.subsPlan) * 100 : null) : card.subsPct;
  const ptPct = useOfd ? (card.ptPlan > 0 ? (ptFact / card.ptPlan) * 100 : null) : card.ptPct;
  const subsDaily = dailyTargetLabel(dailyTarget(card.subsPlan, subsFact, daysLeft));
  const ptDaily = dailyTargetLabel(dailyTarget(card.ptPlan, ptFact, daysLeft));
  const resultKopeks = useOfd ? computeManagementResult(card.ofd.ofdNetKopeks, card.expensesKopeks) : null;
  return (
    <form action={openClubAnalytics.bind(null, card.id)} className="h-full">
      <button
        type="submit"
        className={`group flex h-full w-full flex-col p-5 text-left transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-500 dark:hover:border-brand-700 ${CARD}`}
      >
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {showCompany && card.companyName ? `${card.companyName} · ` : ""}{card.city || "—"}
            </div>
            <div className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">{card.name}</div>
          </div>
          <span aria-hidden className="mt-1 shrink-0 text-slate-300 transition group-hover:text-brand-500 dark:text-slate-600">→</span>
        </div>

        {/* Выручка ОФД — headline (owner/GD/regional, when ОФД has data) */}
        {useOfd ? (
          <div className="mb-3">
            <div className="text-xs text-slate-400 dark:text-slate-500">Выручка ОФД</div>
            <div className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{formatKopeks(card.ofd.ofdRevenueKopeks)}</div>
            <div className="text-[11px] text-slate-400 dark:text-slate-500">
              {card.ofd.ofdReceipts} чеков{card.ofd.ofdReturnsKopeks > 0 ? ` · возвраты ${formatKopeks(card.ofd.ofdReturnsKopeks)}` : ""}
            </div>
          </div>
        ) : null}

        {/* Sales metrics + plan bars (ОФД categories when available) */}
        <div className="grid grid-cols-2 gap-4">
          <MetricBlock label={useOfd ? "Абонементы" : "Продажи АБ"} value={subsFact} pct={subsPct} accent="text-emerald-600 dark:text-emerald-400" />
          <MetricBlock label={useOfd ? "ПТ" : "Продажи ПТ"} value={ptFact} pct={ptPct} accent="text-sky-600 dark:text-sky-400" />
        </div>

        {/* Daily targets */}
        <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
          <div>
            <div className="text-slate-400 dark:text-slate-500">До плана в день · АБ</div>
            <div className={`mt-0.5 font-medium ${subsDaily.cls}`}>{subsDaily.text}</div>
          </div>
          <div>
            <div className="text-slate-400 dark:text-slate-500">До плана в день · ПТ</div>
            <div className={`mt-0.5 font-medium ${ptDaily.cls}`}>{ptDaily.text}</div>
          </div>
        </div>

        {/* Financial fields (hidden from manager/marketer) */}
        {financials ? (
          <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-slate-400 dark:text-slate-500">Расходы</div>
                <div className="mt-0.5 text-base font-semibold text-rose-600 dark:text-rose-400">{formatKopeks(card.expensesKopeks)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400 dark:text-slate-500">{useOfd ? "Результат (ОФД − расходы)" : "Окупаемость"}</div>
                {useOfd ? (
                  <div className={`mt-0.5 text-base font-semibold ${(resultKopeks ?? 0) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>{formatKopeks(resultKopeks ?? 0)}</div>
                ) : (
                  <div className="mt-0.5 text-base font-semibold text-slate-700 dark:text-slate-200">
                    {card.breakEvenKopeks > 0 ? formatKopeks(card.breakEvenKopeks) : <span className="text-sm font-medium text-slate-400 dark:text-slate-500">Бюджет не задан</span>}
                  </div>
                )}
              </div>
            </div>
            {/* Finance Control — per-entity balance + risk (ООО / ИП kept separate) */}
            <div className="mt-3 grid grid-cols-2 gap-4 text-xs">
              <EntityBalanceCell label="ООО" balanceKopeks={card.oooKopeks} risk={card.oooRisk} />
              <EntityBalanceCell label="ИП" balanceKopeks={card.ipKopeks} risk={card.ipRisk} />
            </div>
          </div>
        ) : null}
      </button>
    </form>
  );
}

function EntityBalanceCell({ label, balanceKopeks, risk }: { label: string; balanceKopeks: number | null; risk: "low" | "high" | "unknown" }) {
  const riskCls = risk === "high" ? "text-rose-600 dark:text-rose-400" : risk === "low" ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400 dark:text-slate-500";
  const riskText = risk === "unknown" ? "Нет данных" : risk === "high" ? "Высокий" : "Низкий";
  return (
    <div>
      <div className="text-slate-400 dark:text-slate-500">{label}</div>
      <div className="mt-0.5 font-medium text-slate-700 dark:text-slate-200">{balanceKopeks === null ? "нет данных" : formatKopeks(balanceKopeks)}</div>
      <div className={`mt-0.5 ${riskCls}`}>Риск: {riskText}</div>
    </div>
  );
}

function MetricBlock({ label, value, pct, accent }: { label: string; value: number; pct: number | null; accent: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-slate-400 dark:text-slate-500">{label}</div>
      <div className={`mt-0.5 truncate text-xl font-semibold tracking-tight ${accent}`}>{formatKopeks(value)}</div>
      <div className="mt-2 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className={`h-full rounded-full ${planTone(pct)}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
        </div>
        <span className="w-9 shrink-0 text-right text-[11px] font-medium text-slate-500 dark:text-slate-400">
          {pct === null ? "—" : `${pct.toFixed(0)}%`}
        </span>
      </div>
    </div>
  );
}

// --- preserved management tools --------------------------------------------

async function ManagementSection({
  companyId,
  canEditPlan,
  clubs,
  defaultClubId,
  searchParams,
  now,
}: {
  companyId: string;
  canEditPlan: boolean;
  clubs: { id: string; name: string }[];
  defaultClubId: string;
  searchParams: { month?: string; closeMonth?: string };
  now: Date;
}) {
  const planMonth = monthKey(now);
  const selectedPlanMonth = normalizeMonth(searchParams.month ?? "") ?? planMonth;

  const splitPlanRows = canEditPlan ? await getSalesPlansForCompanyMonth(companyId, selectedPlanMonth) : [];

  // Per-club plan rows for the bulk-import preview (GD plan management).
  const perClubPlan = new Map<string, { total: number; subscriptions: number; personal_training: number }>();
  for (const p of splitPlanRows) {
    if (!p.clubId) continue;
    const cur = perClubPlan.get(p.clubId) ?? { total: 0, subscriptions: 0, personal_training: 0 };
    if (p.planType === "total") cur.total = p.targetAmountKopeks;
    else if (p.planType === "subscriptions") cur.subscriptions = p.targetAmountKopeks;
    else if (p.planType === "personal_training") cur.personal_training = p.targetAmountKopeks;
    perClubPlan.set(p.clubId, cur);
  }
  const dash = (k: number) => (k > 0 ? formatKopeks(k) : "—");
  const planClubRows = clubs
    .filter((c) => perClubPlan.has(c.id))
    .map((c) => {
      const v = perClubPlan.get(c.id)!;
      return { clubName: c.name, month: selectedPlanMonth, total: dash(v.total), subscriptions: dash(v.subscriptions), personal: dash(v.personal_training) };
    });

  return (
    <div className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Управление</h2>

      {canEditPlan && clubs.length > 0 ? (
        <div className={`mt-4 p-4 ${CARD}`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Планы продаж · {capitalize(monthFormatter.format(new Date(`${selectedPlanMonth}-01T00:00:00`)))}
            </div>
            <form method="get" action="/dashboard" className="flex items-end gap-2">
              <label className="block">
                <span className="sr-only">Месяц</span>
                <input type="month" name="month" defaultValue={selectedPlanMonth} className="input" />
              </label>
              <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                Показать
              </button>
            </form>
          </div>
          <SalesPlanForm clubs={clubs} defaultClubId={defaultClubId} defaultMonth={selectedPlanMonth} />
          <SalesPlanImport rows={planClubRows} />
        </div>
      ) : null}
    </div>
  );
}
