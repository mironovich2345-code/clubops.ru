import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getCurrentAccessContext,
  getUserClubs,
} from "@/lib/access";
import { canManageSalesPlans, canImportPlansAndBudgets, canApproveMonthReopen, canAnyRoleAccessPage, isStrategicRole, can, type Role } from "@/lib/auth";
import { loadOfdSyncStatus } from "@/lib/ofd/health";
import { loadOfdProviderCards } from "@/lib/ofd/providers/status";
import { OfdSyncCard } from "./_components/OfdSyncCard";
import { resolveStrategicScope } from "@/lib/strategic-scope";
import { loadCompanyClubCards } from "@/lib/dashboard-cards";
import { getPendingReopenRequestsForCompanies } from "@/lib/month-reopen";
import { StrategicScopeFilter } from "./_components/StrategicScopeFilter";
import { ClubCardsGrid } from "./_components/ClubCard";
import { resolveMonthPeriod } from "@/lib/analytics";
import {
  getSalesPlansForCompanyMonth,
  monthKey,
  normalizeMonth,
} from "@/lib/sales-plans";
import { getPendingReopenRequestsForCompany } from "@/lib/month-reopen";
import { SalesPlanForm } from "./_components/SalesPlanForm";
import { SalesPlanImport } from "./_components/SalesPlanImport";
import { PlanImportPanel } from "./_components/PlanImportPanel";
import { OwnerReopenApprovals, type ReopenRow } from "./_components/OwnerReopenApprovals";
import { DashboardMonthSelector } from "./_components/DashboardMonthSelector";

export const dynamic = "force-dynamic";

const monthFormatter = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Financial fields on a club card (Расходы, Окупаемость) are for owner /
// general_director / regional_director / accountant only. Managers (sales-only)
// and marketers see the sales-only card. Page access itself is unchanged.
const FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "accountant"]);

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

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
  // Owner + general director may bulk-import plans via the template flow (GD also
  // has the manual form; owner gets import only). Reuses ManagementSection.
  const canImportPlans = canImportPlansAndBudgets(roles);
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
      [...byCompany.entries()].map(([cid, g]) => loadCompanyClubCards(cid, g.name, g.clubs, period, financials, now, canSeeOfdSales, canSeeCash)),
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
    const planClubs = canEditPlan || canImportPlans ? (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name })) : [];

    const filteredClubIds = strategic.filteredClubs.map((c) => c.id);
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

        {/* Обзор клубов карточками. Подробные таблицы (ОФД сегодня/вчера/темп, ООО/ИП,
            статьи доходов) остаются в Аналитике и /analytics/ofd-sales. */}
        {strategic.accessibleClubs.length === 0 ? (
          <div className={`px-4 py-16 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
            Нет доступных сетей или клубов
          </div>
        ) : (
          <ClubCardsGrid
            cards={cards}
            showSales={canSeeOfdSales}
            showExpenses={financials}
            showCash={canSeeCash}
            daysLeft={daysLeft}
            showCompany={multiCompany}
            linkFrom={isoDay(period.start)}
            linkTo={isoDay(new Date(period.end.getTime() - 86_400_000))}
          />
        )}

        {canApproveReopen ? <OwnerReopenApprovals requests={strategicReopenRows} /> : null}

        {canEditPlan || canImportPlans ? (
          <ManagementSection
            companyId={companyId}
            canEditPlan={canEditPlan}
            canImportPlans={canImportPlans}
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

  // Обзор клубов карточками — per-club ОФД + расходы + факт-остаток (одна поверхность
  // с Аналитикой). If the topbar selected a single club, show only that card.
  const selectedClubId = scope.club?.id ?? null;
  const cardClubs = (selectedClubId ? clubs.filter((c) => c.id === selectedClubId) : clubs).map((c) => ({ id: c.id, name: c.name, city: c.city ?? "" }));
  const cards = await loadCompanyClubCards(companyId, companyName, cardClubs, period, financials, now, canSeeOfdSales, canSeeCash);
  const daysInSelMonth = new Date(period.start.getFullYear(), period.start.getMonth() + 1, 0).getDate();
  const daysLeftMonth = monthMode === "past" ? 0 : monthMode === "future" ? daysInSelMonth : daysInSelMonth - now.getDate() + 1;

  // Compact OFD data + sync block. Visible to OFD viewers or anyone who may trigger a
  // sync (accountant may trigger without the ofd_sales page). Company-scoped.
  const canTriggerSync = can(roles, "ofd.sync.trigger");
  const showOfdSyncCard = canSeeOfdSales || canTriggerSync;
  const [ofdStatus, ofdProviders] = showOfdSyncCard
    ? await Promise.all([loadOfdSyncStatus(companyId, now), loadOfdProviderCards(companyId, now)])
    : [null, []];
  const anyOfdProvider = ofdProviders.some((p) => p.status !== "disabled");

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <PageHeader title="Дашборд" description="Обзор клубов" />
        <DashboardMonthSelector monthLabel={monthLabel} prevMonth={prevMonth} nextMonth={nextMonth} isCurrent={isCurrentMonth} />
      </div>

      {ofdStatus && anyOfdProvider ? (
        <OfdSyncCard
          state={ofdStatus.state}
          provider={ofdStatus.provider}
          connectionCount={ofdStatus.connectionCount}
          lastSuccessAt={ofdStatus.lastSuccessAt ? ofdStatus.lastSuccessAt.toISOString() : null}
          lastRunAt={ofdStatus.lastRunAt ? ofdStatus.lastRunAt.toISOString() : null}
          lastRunStatus={ofdStatus.lastRunStatus}
          imported={ofdStatus.imported}
          found={ofdStatus.found}
          canTrigger={canTriggerSync}
          providers={ofdProviders.map((p) => ({ id: p.id, label: p.label, statusLabel: p.statusLabel, connected: p.connected }))}
        />
      ) : null}

      {/* Обзор клубов карточками. Подробные ОФД-таблицы — в Аналитике и ОФД-сверке. */}
      <ClubCardsGrid
        cards={cards}
        showSales={canSeeOfdSales}
        showExpenses={financials}
        showCash={canSeeCash}
        daysLeft={daysLeftMonth}
        linkFrom={isoDay(period.start)}
        linkTo={isoDay(new Date(period.end.getTime() - 86_400_000))}
      />

      {/* Critical owner action kept on the dashboard; everything analytical moved out. */}
      {canApproveReopen ? <OwnerReopenApprovals requests={reopenRows} /> : null}

      {/* Sales-plan management (general director). Month close / reopen no longer
          lives on the dashboard — it moved to the Chief Accountant workspace and
          the Owner approval block above. */}
      {canEditPlan || canImportPlans ? (
        <ManagementSection
          companyId={companyId}
          canEditPlan={canEditPlan}
          canImportPlans={canImportPlans}
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

// --- preserved management tools --------------------------------------------

async function ManagementSection({
  companyId,
  canEditPlan,
  canImportPlans,
  clubs,
  defaultClubId,
  searchParams,
  now,
}: {
  companyId: string;
  canEditPlan: boolean;
  canImportPlans: boolean;
  clubs: { id: string; name: string }[];
  defaultClubId: string;
  searchParams: { month?: string; closeMonth?: string };
  now: Date;
}) {
  const planMonth = monthKey(now);
  const selectedPlanMonth = normalizeMonth(searchParams.month ?? "") ?? planMonth;

  const splitPlanRows = canEditPlan || canImportPlans ? await getSalesPlansForCompanyMonth(companyId, selectedPlanMonth) : [];

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

      {(canEditPlan || canImportPlans) && clubs.length > 0 ? (
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
          {canEditPlan ? <SalesPlanForm clubs={clubs} defaultClubId={defaultClubId} defaultMonth={selectedPlanMonth} /> : null}
          <SalesPlanImport rows={planClubRows} />
          {canImportPlans ? <PlanImportPanel month={selectedPlanMonth} /> : null}
        </div>
      ) : null}
    </div>
  );
}
