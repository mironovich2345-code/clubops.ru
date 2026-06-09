import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import { SalesDynamicsChart } from "@/components/SalesDynamicsChart";
import {
  requirePageAccess,
  getCurrentAccessContext,
  getCurrentCompanyAndClub,
} from "@/lib/access";
import { type Role } from "@/lib/auth";
import {
  resolvePeriod,
  loadAnalyticsData,
  buildAnalyticsReport,
  type AnalyticsPeriodKey,
  type TrendGranularity,
  type WeekdayRow,
  type ManagerRow,
  type TopExpenseRow,
} from "@/lib/analytics";

export const dynamic = "force-dynamic";

// Owner cockpit period switch: Неделя / Месяц / Год. Each maps to an existing
// resolvePeriod window + a sensible bucket granularity for the dynamics chart.
type Tab = "week" | "month" | "year";
const TABS: { key: Tab; label: string; period: AnalyticsPeriodKey; gran: TrendGranularity }[] = [
  { key: "week", label: "Неделя", period: "week", gran: "day" },
  { key: "month", label: "Месяц", period: "current_month", gran: "day" },
  { key: "year", label: "Год", period: "year", gran: "month" },
];

// Financial blocks (expenses, expense plan, cash balances, top expenses) are for
// financial roles only. Managers are sales-only and marketers have no financial
// view — both see only the sales blocks. Page access itself is unchanged.
const FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "accountant"]);

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
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

  const sp = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === sp.period) ? (sp.period as Tab) : "month";
  const tabDef = TABS.find((t) => t.key === tab)!;

  const now = new Date();
  const period = resolvePeriod(tabDef.period, now);
  const granularity = tabDef.gran;
  // Local-date bounds for the expense drilldown links (exclusive end), matching
  // the analytics period exactly.
  const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const drillFrom = isoLocal(period.start);
  const drillTo = isoLocal(period.end);

  const data = await loadAnalyticsData(scope.company.id, ctx.allowedClubIds, period);
  const report = buildAnalyticsReport(data, period, granularity);
  const s = report.summary;
  const periodLabel = period.label;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <PageHeader title="Аналитика" description="Бизнес-обзор клуба" />
        {/* Period switch: Неделя / Месяц / Год */}
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={`/analytics?period=${t.key}`}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
                t.key === tab ? "bg-brand-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>

      {/* BLOCK 1 — main KPI cards */}
      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-3">
        <KpiCard label="Продажи абонементов" value={formatKopeks(s.subscriptionsKopeks)} sub={periodLabel} accent="text-emerald-700" />
        <KpiCard label="Продажи персональных тренировок" value={formatKopeks(s.personalTrainingKopeks)} sub={periodLabel} accent="text-indigo-700" />
        {financials ? (
          <>
            <KpiCard label="Фактические расходы" value={formatKopeks(s.expensesKopeks)} sub={periodLabel} accent="text-rose-700" />
            <KpiCard
              label="План расходов"
              value={s.budgetTotalKopeks > 0 ? formatKopeks(s.budgetTotalKopeks) : "Не задан"}
              sub={s.budgetTotalKopeks > 0 ? periodLabel : "бюджет не настроен"}
              muted={s.budgetTotalKopeks === 0}
            />
            <KpiCard
              label="Остаток наличности ООО"
              value={formatKopeks(s.cashOooRemainingKopeks)}
              sub="наличные ООО − инкассация"
              accent={s.cashOooRemainingKopeks < 0 ? "text-rose-700" : "text-slate-900"}
            />
            <KpiCard label="Остаток наличности ИП" value="Скоро" sub="модуль в разработке" muted />
          </>
        ) : null}
      </div>

      {/* BLOCK 2 — sales dynamics */}
      <Panel title="Динамика продаж" hint={periodLabel}>
        <SalesDynamicsChart buckets={report.salesSplitTrend.buckets} />
      </Panel>

      {/* BLOCK 3 — sales by weekday */}
      <WeekdaySalesBlock rows={report.weekdaySales} />

      {/* BLOCK 4 — sales by manager */}
      <ManagerSalesBlock rows={report.managerSales} />

      {/* BLOCK 5 — top expense categories (financial roles only) */}
      {financials ? <TopExpensesBlock rows={report.topExpenses} from={drillFrom} to={drillTo} /> : null}

      {/* BLOCK 6 — forecast placeholder */}
      <ForecastBlock />
    </div>
  );
}

// --- shared building blocks ------------------------------------------------

function KpiCard({ label, value, sub, accent, muted }: { label: string; value: string; sub?: string; accent?: string; muted?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-500">{label}</div>
      <div className={`mt-2 truncate text-2xl font-semibold ${muted ? "text-slate-400" : accent ?? "text-slate-900"}`}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-400">{sub}</div> : null}
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
        <span className="text-sm font-semibold text-slate-700">{title}</span>
        {hint ? <span className="text-xs text-slate-400">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function WeekdaySalesBlock({ rows }: { rows: WeekdayRow[] }) {
  const hasData = rows.some((r) => r.reportCount > 0);
  const dash = (k: number, count: number) => (count > 0 ? formatKopeks(k) : "—");
  return (
    <Panel title="Продажи по дням недели" hint="🏆 — лучший день по средней выручке">
      {!hasData ? (
        <div className="px-4 py-10 text-center text-sm text-slate-500">Нет данных за период</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>День недели</Th>
                <Th className="text-right">Продажи АБ</Th>
                <Th className="text-right">Продажи ПТ</Th>
                <Th className="text-right">Средняя АБ</Th>
                <Th className="text-right">Средняя ПТ</Th>
                <Th className="text-right">Общая выручка</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((r) => (
                <tr key={r.weekday} className={r.isBest ? "bg-emerald-50/60" : "hover:bg-slate-50"}>
                  <Td className="font-medium text-slate-900">
                    {r.isBest ? <span className="mr-1" title="Лучший день по средней выручке">🏆</span> : null}
                    {r.label}
                  </Td>
                  <Td className="text-right text-slate-600">{dash(r.subscriptionsKopeks, r.reportCount)}</Td>
                  <Td className="text-right text-slate-600">{dash(r.personalTrainingKopeks, r.reportCount)}</Td>
                  <Td className="text-right text-slate-600">{dash(r.avgSubscriptionsKopeks, r.reportCount)}</Td>
                  <Td className="text-right text-slate-600">{dash(r.avgPersonalTrainingKopeks, r.reportCount)}</Td>
                  <Td className="text-right font-medium text-slate-900">{dash(r.totalKopeks, r.reportCount)}</Td>
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
    <Panel title="Продажи по менеджерам" hint="🏆 — лучший по средней выручке за смену">
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-slate-500">Нет данных за период</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Менеджер</Th>
                <Th className="text-right">Продажи АБ</Th>
                <Th className="text-right">Продажи ПТ</Th>
                <Th className="text-right">Средняя АБ</Th>
                <Th className="text-right">Средняя ПТ</Th>
                <Th className="text-right">Общая выручка</Th>
                <Th className="text-right">Средняя выручка за смену</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((r) => (
                <tr key={r.manager} className={r.isBest ? "bg-emerald-50/60" : "hover:bg-slate-50"}>
                  <Td className="font-medium text-slate-900">
                    {r.isBest ? <span className="mr-1" title="Лучший по средней выручке за смену">🏆</span> : null}
                    {r.manager}
                  </Td>
                  <Td className="text-right text-slate-600">{formatKopeks(r.subscriptionsKopeks)}</Td>
                  <Td className="text-right text-slate-600">{formatKopeks(r.personalTrainingKopeks)}</Td>
                  <Td className="text-right text-slate-600">{formatKopeks(r.avgSubscriptionsKopeks)}</Td>
                  <Td className="text-right text-slate-600">{formatKopeks(r.avgPersonalTrainingKopeks)}</Td>
                  <Td className="text-right text-slate-900">{formatKopeks(r.totalKopeks)}</Td>
                  <Td className="text-right font-medium text-slate-900">{formatKopeks(r.avgTotalKopeks)}</Td>
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
    <Panel title="Топ расходов по статьям" hint="Нажмите статью для детализации">
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">Расходов за период нет.</div>
      ) : (
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Статья</Th>
              <Th className="text-right">Сумма</Th>
              <Th className="text-right">Доля</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((r) => (
              <tr key={r.category} className="hover:bg-slate-50">
                <Td className="font-medium text-slate-900">
                  <Link href={href(r.category)} className="text-brand-700 hover:text-brand-800 hover:underline">{r.label}</Link>
                </Td>
                <Td className="text-right">{formatKopeks(r.amountKopeks)}</Td>
                <Td className="text-right text-slate-600">{r.sharePercent.toFixed(0)}%</Td>
                <Td className="w-40">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, r.sharePercent)}%` }} />
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ForecastBlock() {
  return (
    <div className="mb-8 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center shadow-sm">
      <div className="text-sm font-semibold text-slate-700">Прогноз</div>
      <div className="mx-auto mt-2 max-w-md text-sm text-slate-400">Модуль прогнозирования будет подключён позже</div>
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
