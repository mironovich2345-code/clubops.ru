import Link from "next/link";
import { CompactPageHeader, MobileDataCard } from "@/components/mobile/density";
import { DateField } from "@/components/mobile/DateField";
import { buttonClass } from "@/components/mobile/buttons";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import { SalesDynamicsChart } from "@/components/SalesDynamicsChart";
import { MonthlyForecastBlock } from "@/components/MonthlyForecastBlock";
import { buildMonthlyForecast } from "@/lib/forecast";
import { getLatestBalancesForScope } from "@/lib/balance-snapshots";
import { loadPaymentObligationsForScope, sumObligationsByEntity } from "@/lib/payment-obligations";
import { buildEntityCashGaps, type EntityCashGap } from "@/lib/balance";
import { dayStart, addDays } from "@/lib/payments";
import {
  requirePageAccess,
  getCurrentAccessContext,
  getCurrentCompanyAndClub,
} from "@/lib/access";
import { isStrategicRole, canAnyRoleAccessPage, type Role } from "@/lib/auth";
import { loadOfdManagementOverview, computeManagementResult, loadOfdWeekday, type OfdWeekdayRow } from "@/lib/analytics/ofd-management";
import { loadScopeCashFactTotals } from "@/lib/cash-collections";
import { resolveStrategicGroups, type StrategicGroups } from "@/lib/strategic-pages";
import { StrategicScopeFilter } from "../dashboard/_components/StrategicScopeFilter";
import {
  resolvePeriod,
  loadAnalyticsData,
  buildAnalyticsReport,
  type AnalyticsPeriodKey,
  type TrendGranularity,
  type PlanSplitCell,
  type WeekdayRow,
  type ManagerRow,
  type TopExpenseRow,
} from "@/lib/analytics";

export const dynamic = "force-dynamic";

// Period selector options. `custom` reads the from/to date inputs.
const PERIOD_OPTIONS: { value: AnalyticsPeriodKey; label: string }[] = [
  { value: "current_week", label: "Текущая неделя" },
  { value: "previous_week", label: "Прошлая неделя" },
  { value: "current_month", label: "Текущий месяц" },
  { value: "previous_month", label: "Прошлый месяц" },
  { value: "current_year", label: "Текущий год" },
  { value: "previous_year", label: "Прошлый год" },
  { value: "custom", label: "Произвольный период" },
];

// Financial blocks (expenses, obligations, cash, profit, top expenses) are for
// financial roles only. Managers are sales-only and marketers have no financial
// view — both see only the sales blocks. Page access itself is unchanged.
const FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "accountant"]);

// Shared, dark-theme-ready surface (dormant `dark:` until a `.dark` ancestor
// exists — see tailwind.config darkMode: "class").
const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

const dfmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// "YYYY-MM-DD" → LOCAL midnight (avoids the UTC day-shift of new Date(str)).
function parseDay(v: string | undefined): Date | undefined {
  const m = v?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

function granularityFor(key: AnalyticsPeriodKey, monthsLen: number): TrendGranularity {
  if (key === "current_year" || key === "previous_year") return "month";
  if (key === "custom") return monthsLen > 2 ? "month" : "day";
  return "day";
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string; scopeMode?: string; companyId?: string; city?: string; clubId?: string }>;
}) {
  const user = await requirePageAccess("analytics");
  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Аналитика" description="Бизнес-обзор клуба" />;
  }
  const ctx = await getCurrentAccessContext();
  if (!ctx) {
    return <NoCompanyState title="Аналитика" description="Бизнес-обзор клуба" />;
  }

  const roles = ctx.effectiveRoles;
  const financials = roles.some((r) => FINANCIAL_ROLES.has(r));
  // ОФД management overlay is owner/GD/regional (ofd_sales access). Manager/marketer
  // keep their existing report-based view and never see ОФД financial sums.
  const canSeeOfdSales = canAnyRoleAccessPage(roles, "ofd_sales");

  const sp = await searchParams;
  const periodKey: AnalyticsPeriodKey = PERIOD_OPTIONS.some((p) => p.value === sp.period)
    ? (sp.period as AnalyticsPeriodKey)
    : "current_month";

  const now = new Date();
  const period = resolvePeriod(periodKey, now, parseDay(sp.from), parseDay(sp.to));
  const granularity = granularityFor(period.key, period.months.length);
  const drillFrom = isoLocal(period.start);
  const drillTo = isoLocal(period.end);
  const lastDay = new Date(period.end.getTime() - 24 * 60 * 60 * 1000);
  const rangeLabel = `${dfmt.format(period.start)} – ${dfmt.format(lastDay)}`;

  // Strategic owner/GD: cross-Company scope. With several Companies selected we
  // show only SAFE additive sales/expense totals + per-Company sections and
  // require one Company for detailed/financial analytics (balances never merge).
  const strategic = isStrategicRole(roles);
  const groups: StrategicGroups | null = strategic ? await resolveStrategicGroups(ctx, sp) : null;
  if (groups && groups.multiCompany) {
    const perCompany = await Promise.all(
      groups.byCompany.map((g) =>
        Promise.all([
          loadAnalyticsData(g.companyId, g.clubIds, period).then((d) => buildAnalyticsReport(d, period, granularity)),
          canSeeOfdSales ? loadOfdManagementOverview(g.companyId, g.clubIds, period.start, period.end) : Promise.resolve(null),
        ]).then(([r, ofd]) => ({ g, r, ofd })),
      ),
    );
    // Продажи АБ/ПТ from ОФД categories when ОФД has data for a network; the rest
    // keep the confirmed-report totals. Расходы always from the finance logic.
    const netRows = perCompany.map((p) => {
      const useOfd = !!p.ofd && p.ofd.hasData;
      return {
        companyId: p.g.companyId,
        companyName: p.g.companyName,
        clubs: p.g.clubIds.length,
        ab: useOfd ? p.ofd!.totals.subscriptionsKopeks : p.r.summary.subscriptionsKopeks,
        pt: useOfd ? p.ofd!.totals.personalTrainingKopeks : p.r.summary.personalTrainingKopeks,
        rev: p.ofd?.totals.incomeKopeks ?? 0,
        exp: p.r.summary.expensesKopeks,
      };
    });
    const anyOfd = netRows.some((r) => r.rev > 0);
    const tAb = netRows.reduce((x, r) => x + r.ab, 0);
    const tPt = netRows.reduce((x, r) => x + r.pt, 0);
    const tRev = netRows.reduce((x, r) => x + r.rev, 0);
    const tExp = netRows.reduce((x, r) => x + r.exp, 0);
    return (
      <div className="mx-auto max-w-[1440px]">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <CompactPageHeader title="Аналитика" subtitle="Все доступные сети" />
          <span className="text-sm text-slate-500 dark:text-slate-400">{period.label} · {rangeLabel}</span>
        </div>
        <div className="mb-5">
          <StrategicScopeFilter
            companies={groups.scope.accessibleCompanies}
            clubs={groups.scope.accessibleClubs}
            mode={groups.scope.mode}
            companyId={groups.scope.selectedCompanyId}
            city={groups.scope.selectedCity}
            clubId={groups.scope.selectedClubId}
            month=""
            basePath="/analytics"
            extra={{ period: periodKey, from: sp.from ?? "", to: sp.to ?? "" }}
          />
        </div>
        <div className="mb-4 grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-4">
          {anyOfd ? <KpiCard label="Выручка ОФД (все сети)" value={formatKopeks(tRev)} accent="text-brand-700 dark:text-brand-400" /> : null}
          <KpiCard label="Продажи АБ (все сети)" value={formatKopeks(tAb)} accent="text-emerald-600 dark:text-emerald-400" />
          <KpiCard label="Продажи ПТ (все сети)" value={formatKopeks(tPt)} accent="text-sky-600 dark:text-sky-400" />
          {financials ? <KpiCard label="Расходы (все сети)" value={formatKopeks(tExp)} accent="text-rose-600 dark:text-rose-400" /> : null}
          <KpiCard label="Клубов в выборке" value={String(groups.filteredClubIds.length)} />
        </div>
        {/* Mobile: one card per network (no clipped table). Desktop: the full table. */}
        <div className="space-y-3 lg:hidden">
          {netRows.map((r) => (
            <MobileDataCard
              key={`net-${r.companyId}`}
              title={r.companyName}
              rows={[
                ...(anyOfd ? [{ label: "Выручка ОФД", value: formatKopeks(r.rev), strong: true }] : []),
                { label: "Продажи АБ", value: formatKopeks(r.ab) },
                { label: "Продажи ПТ", value: formatKopeks(r.pt) },
                ...(financials ? [{ label: "Расходы", value: formatKopeks(r.exp) }] : []),
                ...(financials && anyOfd ? [{ label: "Результат", value: formatKopeks(r.rev - r.exp), strong: true, tone: (r.rev - r.exp) < 0 ? "danger" as const : "success" as const }] : []),
                { label: "Клубов", value: String(r.clubs) },
              ]}
            />
          ))}
        </div>
        <div className="hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm lg:block dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-slate-800 dark:text-slate-200">По сетям</div>
          <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr><Th>Сеть</Th>{anyOfd ? <Th className="text-right">Выручка ОФД</Th> : null}<Th className="text-right">Продажи АБ</Th><Th className="text-right">Продажи ПТ</Th>{financials ? <Th className="text-right">Расходы</Th> : null}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {netRows.map((r) => (
                <tr key={r.companyId} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">{r.companyName}</Td>
                  {anyOfd ? <Td className="text-right">{formatKopeks(r.rev)}</Td> : null}
                  <Td className="text-right">{formatKopeks(r.ab)}</Td>
                  <Td className="text-right">{formatKopeks(r.pt)}</Td>
                  {financials ? <Td className="text-right">{formatKopeks(r.exp)}</Td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Выберите одну компанию, чтобы увидеть подробную аналитику, остатки и прогноз. Остатки и кассовые разрывы разных сетей не суммируются.
        </div>
      </div>
    );
  }

  // Single Company in scope (strategic-filtered or non-strategic): full analytics.
  const aCompanyId = groups ? groups.filteredCompanyIds[0] ?? scope.company.id : scope.company.id;
  // Non-strategic (regional/manager): honour a ?clubId= from a dashboard club-card
  // click, but ONLY if it is within the caller's allowed clubs — a foreign clubId is
  // ignored (falls back to full allowed scope), never leaking another club's data.
  const requestedClubId = !groups && sp.clubId && ctx.allowedClubIds.includes(sp.clubId) ? sp.clubId : null;
  const aClubIds = groups ? groups.filteredClubIds : requestedClubId ? [requestedClubId] : ctx.allowedClubIds;
  const data = await loadAnalyticsData(aCompanyId, aClubIds, period);
  const report = buildAnalyticsReport(data, period, granularity);
  const s = report.summary;

  // ОФД management overlay (owner/GD/regional): use real ОФД revenue by category so
  // Продажи АБ/ПТ are not stuck at 0. Расходы keep the confirmed finance logic.
  const ofd = canSeeOfdSales ? await loadOfdManagementOverview(aCompanyId, aClubIds, period.start, period.end) : null;
  const useOfd = !!ofd && ofd.hasData;
  const abValue = useOfd ? ofd!.totals.subscriptionsKopeks : s.subscriptionsKopeks;
  const ptValue = useOfd ? ofd!.totals.personalTrainingKopeks : s.personalTrainingKopeks;
  const ofdRevenueKopeks = ofd?.totals.incomeKopeks ?? 0;
  const ofdResultKopeks = useOfd ? computeManagementResult(ofd!.totals.netKopeks, s.expensesKopeks) : 0;
  // «Продажи по дням недели» from ОФД (replaces the retired SalesReport source).
  const ofdWeekday = useOfd ? await loadOfdWeekday(aCompanyId, aClubIds, period.start, period.end) : null;

  // --- Monthly forecast inputs. The month FACT is the ОФД revenue (gross income)
  // for owner/GD/regional when ОФД has data, so pace/plan/risk reflect ОФД instead
  // of the retired manual sales reports; otherwise the confirmed-report split. ---
  const salesFact = useOfd ? ofdRevenueKopeks : s.subscriptionsKopeks + s.personalTrainingKopeks;
  // Total plan if set, otherwise subscriptions + personal-training plans.
  const splitPlan = report.planTotals.subscriptions.planKopeks + report.planTotals.personal_training.planKopeks;
  const salesPlan = s.planTargetKopeks > 0 ? s.planTargetKopeks : splitPlan;
  // Previous-month forecast only makes sense for the current calendar month, and
  // only for the report-based fact (the ОФД overlay window covers one period only).
  let previousMonthRemainingSales: number | null = null;
  if (!useOfd && period.key === "current_month") {
    const prevRows = data.reportSplit.filter((r) => r.date >= period.prevStart && r.date < period.prevEnd);
    if (prevRows.length > 0) {
      const cutoffDay = now.getDate();
      previousMonthRemainingSales = prevRows
        .filter((r) => r.date.getDate() >= cutoffDay)
        .reduce((acc, r) => acc + r.subscriptions + r.personal_training, 0);
    }
  }
  const forecast = buildMonthlyForecast({
    salesFact,
    salesPlan,
    expenseBudget: s.budgetTotalKopeks,
    periodStart: period.start,
    periodEnd: period.end,
    now,
    previousMonthRemainingSales,
  });

  const fromValue = sp.from ?? drillFrom;
  const toValue = sp.to ?? isoLocal(lastDay);

  // Part 6 — financial control cards (financial roles only): ООО and ИП forecasts
  // computed SEPARATELY (never merged). Scoped to allowedClubIds.
  let entityGaps: { ooo: EntityCashGap; ip: EntityCashGap } | null = null;
  // Current ООО / ИП fact cash for the "Финансовый итог" card (loadClubCashBalances,
  // the single source of truth) — replaces the retired SalesReport cash line.
  let scopeCash = { oooKopeks: 0, ipKopeks: 0 };
  if (financials) {
    const horizon = addDays(dayStart(now), 30);
    const [bal, { obligations: payObs }, cash] = await Promise.all([
      getLatestBalancesForScope(aCompanyId, aClubIds),
      loadPaymentObligationsForScope({ companyId: aCompanyId, clubIds: aClubIds, loadEnd: horizon }),
      loadScopeCashFactTotals(aCompanyId, aClubIds, now),
    ]);
    scopeCash = cash;
    const sums = sumObligationsByEntity(payObs, horizon);
    entityGaps = buildEntityCashGaps({
      ooo: { balanceKopeks: bal.ooo.kopeks, obligationsKopeks: sums.ooo },
      ip: { balanceKopeks: bal.ip.kopeks, obligationsKopeks: sums.ip },
    });
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      {/* Header + period selector */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <CompactPageHeader title="Аналитика" subtitle="Бизнес-обзор клуба" />
        {/* Mobile: one column, full-width controls + full-width primary on its own row
            (no button/date overlap, §5). Desktop: compact horizontal row. */}
        <form method="get" className={`grid grid-cols-1 gap-3 p-4 ${CARD} lg:flex lg:flex-wrap lg:items-end lg:gap-2 lg:p-2`}>
          {groups ? (
            <>
              <input type="hidden" name="scopeMode" value={groups.scope.mode} />
              {groups.scope.selectedCompanyId ? <input type="hidden" name="companyId" value={groups.scope.selectedCompanyId} /> : null}
              {groups.scope.selectedCity ? <input type="hidden" name="city" value={groups.scope.selectedCity} /> : null}
              {groups.scope.selectedClubId ? <input type="hidden" name="clubId" value={groups.scope.selectedClubId} /> : null}
            </>
          ) : null}
          <label className="block min-w-0">
            <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Период</span>
            <select name="period" defaultValue={periodKey} className="input w-full">
              {PERIOD_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </label>
          <DateField label="С даты" name="from" defaultValue={fromValue} />
          <DateField label="По дату" name="to" defaultValue={toValue} />
          <button type="submit" className={`${buttonClass({ variant: "primary" })} w-full lg:w-auto`}>
            Показать
          </button>
        </form>
      </div>

      {groups && groups.scope.accessibleClubs.length > 0 ? (
        <div className="mb-5">
          <StrategicScopeFilter
            companies={groups.scope.accessibleCompanies}
            clubs={groups.scope.accessibleClubs}
            mode={groups.scope.mode}
            companyId={groups.scope.selectedCompanyId}
            city={groups.scope.selectedCity}
            clubId={groups.scope.selectedClubId}
            month=""
            basePath="/analytics"
            extra={{ period: periodKey, from: sp.from ?? "", to: sp.to ?? "" }}
          />
        </div>
      ) : null}

      {/* Selected-period chip */}
      <div className="mb-5 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <span className="font-medium text-slate-700 dark:text-slate-200">{period.label}</span>
        <span className="text-slate-300 dark:text-slate-600">·</span>
        <span>{rangeLabel}</span>
      </div>

      {/* Part 2 — top KPI grid with plan progress on the sales cards. Продажи АБ/ПТ
          come from ОФД categories for owner/GD/regional when ОФД has data. */}
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {useOfd ? (
          <KpiCard label="Выручка ОФД" value={formatKopeks(ofdRevenueKopeks)} sub={rangeLabel} accent="text-brand-700 dark:text-brand-400" />
        ) : null}
        <KpiCard
          label={useOfd ? "Абонементы (ОФД)" : "Продажи абонементов"}
          value={formatKopeks(abValue)}
          sub={rangeLabel}
          accent="text-emerald-600 dark:text-emerald-400"
          trend={{ cur: abValue, prev: s.prevSubscriptionsKopeks, goodWhenUp: true }}
          progress={report.planTotals.subscriptions}
        />
        <KpiCard
          label={useOfd ? "Персональные тренировки (ОФД)" : "Продажи персональных тренировок"}
          value={formatKopeks(ptValue)}
          sub={rangeLabel}
          accent="text-sky-600 dark:text-sky-400"
          trend={{ cur: ptValue, prev: s.prevPersonalTrainingKopeks, goodWhenUp: true }}
          progress={report.planTotals.personal_training}
        />
        {financials ? (
          <>
            <KpiCard
              label="Фактические расходы"
              value={formatKopeks(s.expensesKopeks)}
              sub={rangeLabel}
              accent="text-rose-600 dark:text-rose-400"
              trend={{ cur: s.expensesKopeks, prev: s.prevExpensesKopeks, goodWhenUp: false }}
            />
            {useOfd ? (
              <KpiCard
                label="Результат (ОФД − расходы)"
                value={formatKopeks(ofdResultKopeks)}
                sub="выручка ОФД за вычетом подтверждённых расходов"
                accent={ofdResultKopeks >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}
              />
            ) : null}
            <KpiCard
              label="Долги / обязательства"
              value={formatKopeks(s.obligationsKopeks)}
              sub="согласованные неоплаченные счета и возвраты"
              accent={s.obligationsKopeks > 0 ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100"}
            />
          </>
        ) : null}
      </div>

      {/* Part 6 (Finance Control) — ООО / ИП forecasts kept separate (no merge) */}
      {financials && entityGaps ? (
        <div className="mb-4 grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Прогноз ООО"
            value={entityGaps.ooo.projectedBalanceKopeks === null ? "нет данных" : formatKopeks(entityGaps.ooo.projectedBalanceKopeks)}
            sub={entityGaps.ooo.currentBalanceKopeks === null ? "остаток не задан" : `остаток ${formatKopeks(entityGaps.ooo.currentBalanceKopeks)}`}
            accent={entityGaps.ooo.projectedBalanceKopeks !== null && entityGaps.ooo.projectedBalanceKopeks < 0 ? "text-rose-600 dark:text-rose-400" : undefined}
          />
          <KpiCard
            label="Прогноз ИП"
            value={entityGaps.ip.projectedBalanceKopeks === null ? "нет данных" : formatKopeks(entityGaps.ip.projectedBalanceKopeks)}
            sub={entityGaps.ip.currentBalanceKopeks === null ? "остаток не задан" : `остаток ${formatKopeks(entityGaps.ip.currentBalanceKopeks)}`}
            accent={entityGaps.ip.projectedBalanceKopeks !== null && entityGaps.ip.projectedBalanceKopeks < 0 ? "text-rose-600 dark:text-rose-400" : undefined}
          />
          <KpiCard
            label="Риск ООО"
            value={entityGaps.ooo.risk === "unknown" ? "Нет данных" : entityGaps.ooo.risk === "high" ? "Высокий" : "Низкий"}
            accent={entityGaps.ooo.risk === "high" ? "text-rose-600 dark:text-rose-400" : entityGaps.ooo.risk === "low" ? "text-emerald-600 dark:text-emerald-400" : undefined}
          />
          <KpiCard
            label="Риск ИП"
            value={entityGaps.ip.risk === "unknown" ? "Нет данных" : entityGaps.ip.risk === "high" ? "Высокий" : "Низкий"}
            accent={entityGaps.ip.risk === "high" ? "text-rose-600 dark:text-rose-400" : entityGaps.ip.risk === "low" ? "text-emerald-600 dark:text-emerald-400" : undefined}
          />
        </div>
      ) : null}

      {/* Part 1/2 — monthly forecast (financial roles only; hidden from
          manager/marketer, who see operational sales metrics only) */}
      {financials ? (
        <div className="mb-5">
          <MonthlyForecastBlock forecast={forecast} financials={financials} hint={period.label} />
        </div>
      ) : null}

      {/* Part 3/6 — sales dynamics + combined financial summary card */}
      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className={`min-w-0 ${financials ? "lg:col-span-2" : "lg:col-span-3"}`}>
          <Panel title="Динамика продаж" hint={rangeLabel}>
            <SalesDynamicsChart buckets={report.salesSplitTrend.buckets} height={180} />
          </Panel>
        </div>
        {financials ? (
          <FinancialSummaryCard
            profit={useOfd ? ofdResultKopeks : s.profitKopeks}
            prevProfit={useOfd ? 0 : s.prevProfitKopeks}
            oooKopeks={scopeCash.oooKopeks}
            ipKopeks={scopeCash.ipKopeks}
            isOfd={useOfd}
            sub={rangeLabel}
          />
        ) : null}
      </div>

      {/* Part 5 — lower analytics grid (managers + weekday; expenses for financial) */}
      <div className={`grid grid-cols-1 gap-4 ${financials ? "xl:grid-cols-2" : ""}`}>
        <div className="flex min-w-0 flex-col gap-4">
          {/* ОФД is the sales source: weekday sales come from OfdDailySalesSummary.
              The manual manager/weekday reports are retired, so they are shown only
              as a fallback when ОФД has no data for the scope/period. */}
          {useOfd ? (
            <OfdWeekdayBlock rows={ofdWeekday!} />
          ) : (
            <>
              <ManagerSalesBlock rows={report.managerSales} />
              <WeekdaySalesBlock rows={report.weekdaySales} />
            </>
          )}
        </div>
        {financials ? (
          <div className="flex min-w-0 flex-col gap-4">
            <TopExpensesBlock rows={report.topExpenses} from={drillFrom} to={drillTo} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --- shared building blocks ------------------------------------------------

function deltaPct(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

function TrendChip({ cur, prev, goodWhenUp }: { cur: number; prev: number; goodWhenUp: boolean }) {
  const d = deltaPct(cur, prev);
  if (d === null) return null;
  const flat = Math.abs(d) < 0.5;
  const up = d > 0;
  const good = up === goodWhenUp;
  const cls = flat
    ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
    : good
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
      : "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400";
  return (
    <span className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${cls}`} title="к предыдущему периоду">
      {flat ? "→" : up ? "↑" : "↓"} {Math.abs(d).toFixed(0)}%
    </span>
  );
}

/** Plan-completion bar: <80% red, 80–99% amber, ≥100% green. */
function PlanProgress({ cell }: { cell: PlanSplitCell }) {
  if (cell.planKopeks <= 0) {
    return <div className="mt-3 text-xs text-slate-400 dark:text-slate-500">План не задан</div>;
  }
  const pct = cell.percent ?? 0;
  const tone = pct >= 100 ? "bg-emerald-500" : pct >= 80 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
        <span>План: {formatKopeks(cell.planKopeks)}</span>
        <span className="font-semibold text-slate-700 dark:text-slate-200">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  accent,
  muted,
  trend,
  progress,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  muted?: boolean;
  trend?: { cur: number; prev: number; goodWhenUp: boolean };
  progress?: PlanSplitCell;
}) {
  return (
    <div className={`flex h-full flex-col p-3 ${CARD}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium leading-tight text-slate-500 dark:text-slate-400">{label}</div>
        {trend ? <TrendChip cur={trend.cur} prev={trend.prev} goodWhenUp={trend.goodWhenUp} /> : null}
      </div>
      <div className={`mt-1 whitespace-nowrap font-semibold tabular-nums tracking-tight ${muted ? "text-slate-400 dark:text-slate-500" : accent ?? "text-slate-900 dark:text-slate-100"}`} style={{ fontSize: "clamp(1.1rem, 5.5vw, 1.75rem)" }}>
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">{sub}</div> : null}
      {progress ? <PlanProgress cell={progress} /> : null}
    </div>
  );
}

/** Part 6 — combined financial summary. Прибыль/результат = ОФД net − подтверждённые
 * расходы (управленческий результат) when ОФД has data; наличные ООО/ИП = фактический
 * остаток из cash-balances (loadClubCashBalances) — never the retired SalesReport cash. */
function FinancialSummaryCard({
  profit,
  prevProfit,
  oooKopeks,
  ipKopeks,
  isOfd,
  sub,
}: {
  profit: number;
  prevProfit: number;
  oooKopeks: number;
  ipKopeks: number;
  isOfd: boolean;
  sub: string;
}) {
  const profitAccent = profit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  return (
    <div className={`flex h-full flex-col p-5 ${CARD}`}>
      <div className="text-sm font-medium text-slate-500 dark:text-slate-400">Финансовый итог</div>
      <div className="mt-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-slate-400 dark:text-slate-500">{isOfd ? "Результат (ОФД − расходы)" : "Прибыль"}</div>
          <div className={`truncate text-2xl font-semibold tracking-tight ${profitAccent}`}>{formatKopeks(profit)}</div>
        </div>
        {isOfd ? null : <TrendChip cur={profit} prev={prevProfit} goodWhenUp />}
      </div>
      <dl className="mt-4 space-y-2.5 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-xs text-slate-400 dark:text-slate-500">Наличные ООО</dt>
          <dd className={`text-sm font-semibold ${oooKopeks < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-900 dark:text-slate-100"}`}>
            {formatKopeks(oooKopeks)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-xs text-slate-400 dark:text-slate-500">Наличные ИП</dt>
          <dd className={`text-sm font-semibold ${ipKopeks < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-900 dark:text-slate-100"}`}>
            {formatKopeks(ipKopeks)}
          </dd>
        </div>
      </dl>
      <div className="mt-3 text-xs text-slate-400 dark:text-slate-500">{sub}</div>
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={`flex h-full flex-col overflow-hidden ${CARD}`}>
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</span>
        {hint ? <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function BestBadge({ text }: { text: string }) {
  return (
    <span className="ml-2 inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20">
      {text}
    </span>
  );
}

function OfdWeekdayBlock({ rows }: { rows: OfdWeekdayRow[] }) {
  const hasData = rows.some((r) => r.dayCount > 0);
  const dash = (k: number, count: number) => (count > 0 ? formatKopeks(k) : "—");
  return (
    <Panel title="Продажи по дням недели" hint="из чеков ОФД · лучший — по средней выручке">
      {!hasData ? (
        <EmptyRow />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr>
                <Th>День недели</Th>
                <Th className="text-right">Выручка ОФД</Th>
                <Th className="text-right">Чеков</Th>
                <Th className="text-right">Средняя выручка</Th>
                <Th className="text-right">Дней</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {rows.map((r) => (
                <tr key={r.weekday} className={r.isBest ? "bg-emerald-50/60 dark:bg-emerald-500/10" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"}>
                  <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">
                    {r.label}
                    {r.isBest ? <BestBadge text="Лучший день" /> : null}
                  </Td>
                  <Td className="text-right font-medium text-slate-900 dark:text-slate-100">{dash(r.revenueKopeks, r.dayCount)}</Td>
                  <Td className="text-right">{r.dayCount > 0 ? r.receipts : "—"}</Td>
                  <Td className="text-right">{dash(r.avgRevenueKopeks, r.dayCount)}</Td>
                  <Td className="text-right">{r.dayCount > 0 ? r.dayCount : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function WeekdaySalesBlock({ rows }: { rows: WeekdayRow[] }) {
  const hasData = rows.some((r) => r.reportCount > 0);
  const dash = (k: number, count: number) => (count > 0 ? formatKopeks(k) : "—");
  return (
    <Panel title="Продажи по дням недели" hint="лучший — по средней выручке">
      {!hasData ? (
        <EmptyRow />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr>
                <Th>День недели</Th>
                <Th className="text-right">Продажи АБ</Th>
                <Th className="text-right">Продажи ПТ</Th>
                <Th className="text-right">Средняя АБ</Th>
                <Th className="text-right">Средняя ПТ</Th>
                <Th className="text-right">Общая выручка</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {rows.map((r) => (
                <tr key={r.weekday} className={r.isBest ? "bg-emerald-50/60 dark:bg-emerald-500/10" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"}>
                  <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">
                    {r.label}
                    {r.isBest ? <BestBadge text="Лучший день" /> : null}
                  </Td>
                  <Td className="text-right">{dash(r.subscriptionsKopeks, r.reportCount)}</Td>
                  <Td className="text-right">{dash(r.personalTrainingKopeks, r.reportCount)}</Td>
                  <Td className="text-right">{dash(r.avgSubscriptionsKopeks, r.reportCount)}</Td>
                  <Td className="text-right">{dash(r.avgPersonalTrainingKopeks, r.reportCount)}</Td>
                  <Td className="text-right font-medium text-slate-900 dark:text-slate-100">{dash(r.totalKopeks, r.reportCount)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ManagerSalesBlock({ rows }: { rows: ManagerRow[] }) {
  return (
    <Panel title="Продажи по менеджерам" hint="лучший — по средней выручке за смену">
      {rows.length === 0 ? (
        <EmptyRow />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr>
                <Th>Менеджер</Th>
                <Th className="text-right">Продажи АБ</Th>
                <Th className="text-right">Продажи ПТ</Th>
                <Th className="text-right">Средняя АБ</Th>
                <Th className="text-right">Средняя ПТ</Th>
                <Th className="text-right">Общая выручка</Th>
                <Th className="text-right">Средняя за смену</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {rows.map((r) => (
                <tr key={r.manager} className={r.isBest ? "bg-emerald-50/60 dark:bg-emerald-500/10" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"}>
                  <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">
                    {r.manager}
                    {r.isBest ? <BestBadge text="Лучший менеджер" /> : null}
                  </Td>
                  <Td className="text-right">{formatKopeks(r.subscriptionsKopeks)}</Td>
                  <Td className="text-right">{formatKopeks(r.personalTrainingKopeks)}</Td>
                  <Td className="text-right">{formatKopeks(r.avgSubscriptionsKopeks)}</Td>
                  <Td className="text-right">{formatKopeks(r.avgPersonalTrainingKopeks)}</Td>
                  <Td className="text-right text-slate-900 dark:text-slate-100">{formatKopeks(r.totalKopeks)}</Td>
                  <Td className="text-right font-medium text-slate-900 dark:text-slate-100">{formatKopeks(r.avgTotalKopeks)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function TopExpensesBlock({ rows, from, to }: { rows: TopExpenseRow[]; from: string; to: string }) {
  const href = (category: string) => `/analytics/expenses?category=${encodeURIComponent(category)}&from=${from}&to=${to}`;
  return (
    <Panel title="Статистика по статьям расхода" hint="нажмите статью для детализации">
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">Расходов за период нет.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr>
                <Th>Статья</Th>
                <Th className="text-right">Сумма</Th>
                <Th className="text-right">Доля</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {rows.map((r) => (
                <tr key={r.category} className="group cursor-pointer hover:bg-brand-50/50 dark:hover:bg-brand-500/10">
                  <Td>
                    <Link href={href(r.category)} className="flex items-center gap-1 font-medium text-brand-700 group-hover:underline dark:text-brand-500">
                      {r.label}
                      <span aria-hidden className="text-brand-400 opacity-0 transition group-hover:opacity-100">→</span>
                    </Link>
                  </Td>
                  <Td className="text-right">{formatKopeks(r.amountKopeks)}</Td>
                  <Td className="text-right text-slate-600 dark:text-slate-300">{r.sharePercent.toFixed(0)}%</Td>
                  <Td className="w-32">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, r.sharePercent)}%` }} />
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function EmptyRow() {
  return <div className="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">Нет данных за период</div>;
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${className ?? ""}`}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-middle text-sm text-slate-700 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
