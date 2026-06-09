import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import { BarChart } from "@/components/BarChart";
import { BudgetFactTable } from "@/components/BudgetFactTable";
import { ExportButton } from "@/components/ExportButton";
import { allowedExportTypes, EXPORT_LABELS } from "@/lib/exports";
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
  type Trend,
  type ClubRankRow,
  type PlanPerfRow,
  type PlanSplitClubRow,
  type WeekdayRow,
  type ManagerRow,
  type TopExpenseRow,
  type CriticalZone,
} from "@/lib/analytics";

export const dynamic = "force-dynamic";

const PERIODS: { key: AnalyticsPeriodKey; label: string }[] = [
  { key: "current_month", label: "Текущий месяц" },
  { key: "previous_month", label: "Прошлый месяц" },
  { key: "custom", label: "Период" },
];
const GRANS: { key: TrendGranularity; label: string }[] = [
  { key: "day", label: "По дням" },
  { key: "week", label: "По неделям" },
  { key: "month", label: "По месяцам" },
];

// Financial analytics (expenses, profit, club financial ranking, budgets, top
// expenses, cash control). A manager is sales-only and a marketer sees
// sales/plans/advertising — both are excluded here.
const FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "accountant"]);

function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function pct(v: number | null, digits = 0): string {
  return v === null ? "—" : `${v.toFixed(digits)}%`;
}

function changeSentence(noun: string, change: number | null): string {
  if (change === null) return `${noun}: нет данных за прошлый период`;
  if (change > 0) return `${noun} выросли на ${change.toFixed(0)}%`;
  if (change < 0) return `${noun} снизились на ${Math.abs(change).toFixed(0)}%`;
  return `${noun} без изменений`;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string; g?: string }>;
}) {
  const user = await requirePageAccess("analytics");
  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Аналитика" description="Стратегический обзор сети" />;
  }
  const ctx = await getCurrentAccessContext();
  if (!ctx) {
    return <NoCompanyState title="Аналитика" description="Стратегический обзор сети" />;
  }

  const roles = ctx.effectiveRoles;
  const financials = roles.some((r) => FINANCIAL_ROLES.has(r));
  const marketerOnly = roles.includes("marketer") && !financials;
  const exportTypes = allowedExportTypes(roles);

  const sp = await searchParams;
  const periodKey: AnalyticsPeriodKey = PERIODS.some((p) => p.key === sp.period)
    ? (sp.period as AnalyticsPeriodKey)
    : "current_month";
  const now = new Date();
  const period = resolvePeriod(periodKey, now, parseDate(sp.from), parseDate(sp.to));
  const granularity: TrendGranularity = GRANS.some((g) => g.key === sp.g)
    ? (sp.g as TrendGranularity)
    : period.months.length > 2
      ? "month"
      : "day";

  const data = await loadAnalyticsData(scope.company.id, ctx.allowedClubIds, period);
  const report = buildAnalyticsReport(data, period, granularity, marketerOnly ? { categories: ["advertising"] } : undefined);

  const multiClub = data.clubs.length > 1;

  return (
    <div>
      <PageHeader title="Аналитика" description="Стратегический обзор сети" />

      {/* Period + granularity selector */}
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Период</span>
          <select name="period" defaultValue={periodKey} className="input">
            {PERIODS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">С даты</span>
          <input type="date" name="from" defaultValue={sp.from ?? ""} className="input" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">По дату</span>
          <input type="date" name="to" defaultValue={sp.to ?? ""} className="input" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Детализация</span>
          <select name="g" defaultValue={granularity} className="input">
            {GRANS.map((g) => (
              <option key={g.key} value={g.key}>{g.label}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
          Показать
        </button>
      </form>

      {/* Block 1: executive summary */}
      <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard
          label="Продажи"
          value={formatKopeks(report.summary.salesKopeks)}
          sub={report.salesTrend.changePercent === null ? undefined : `${report.salesTrend.changePercent >= 0 ? "+" : ""}${report.salesTrend.changePercent.toFixed(0)}% к прошлому периоду`}
        />
        {financials ? <KpiCard label="Расходы" value={formatKopeks(report.summary.expensesKopeks)} /> : null}
        {financials ? (
          <KpiCard
            label="Прибыль"
            value={formatKopeks(report.summary.profitKopeks)}
            accent={report.summary.profitKopeks >= 0 ? "text-emerald-700" : "text-rose-700"}
          />
        ) : null}
        <KpiCard
          label="Выполнение плана"
          value={pct(report.summary.planPercent)}
          sub={report.summary.planTargetKopeks > 0 ? `из ${formatKopeks(report.summary.planTargetKopeks)}` : "план не задан"}
          accent={planTone(report.summary.planPercent)}
        />
        {financials ? (
          <KpiCard
            label="Остаток наличности ООО"
            value={formatKopeks(report.summary.cashOooRemainingKopeks)}
            sub="наличные ООО − инкассация (подтверждённые отчёты)"
            accent={report.summary.cashOooRemainingKopeks < 0 ? "text-rose-700" : "text-slate-900"}
          />
        ) : null}
      </div>

      {/* Выгрузки CSV */}
      {exportTypes.length > 0 ? (
        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 text-sm font-semibold text-slate-700">Выгрузки</div>
          <div className="flex flex-wrap gap-2">
            {exportTypes.map((t) => (
              <ExportButton key={t} type={t} label={`${EXPORT_LABELS[t]} (CSV)`} />
            ))}
          </div>
        </div>
      ) : null}

      {/* Block 2: sales trend (everyone) */}
      <TrendCard title="Динамика продаж" trend={report.salesTrend} noun="Продажи" tone="emerald" />

      {/* Block 3: expense trend (financial roles) */}
      {financials ? (
        <TrendCard title="Динамика расходов" trend={report.expenseTrend} noun="Расходы" tone="rose" />
      ) : null}

      {/* Block 4: profit trend (financial roles) */}
      {financials ? (
        <TrendCard title="Динамика прибыли" trend={report.profitTrend} noun="Прибыль" tone="brand" />
      ) : null}

      {/* Block 5: club ranking (financial roles) */}
      {financials && multiClub ? <ClubRankingBlock rows={report.clubRanking} /> : null}

      {/* Block 6: sales plan performance (everyone) */}
      <PlanPerformanceBlock rows={report.planPerformance} />

      {/* Block 6b: plan/fact split by direction (everyone) */}
      <PlanSplitBlock rows={report.planSplitByClub} />

      {/* Block 6c: sales by weekday (everyone) */}
      <WeekdaySalesBlock rows={report.weekdaySales} />

      {/* Block 6d: sales by manager (everyone) */}
      <ManagerSalesBlock rows={report.managerSales} />

      {/* Block 7: budget performance (financial roles, or advertising for marketer) */}
      {financials || marketerOnly ? (
        <div className="mb-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <SectionHeader title={marketerOnly ? "Бюджет: реклама" : "Исполнение бюджета"} />
          <BudgetFactTable rows={report.budgetPerformance} />
        </div>
      ) : null}

      {/* Block 8: top expenses (financial roles) */}
      {financials ? <TopExpensesBlock rows={report.topExpenses} /> : null}

      {/* Block 9: critical zones (financial roles, or advertising/plan for marketer) */}
      {financials || marketerOnly ? <CriticalZonesBlock zones={report.criticalZones} /> : null}
    </div>
  );
}

// --- shared building blocks ------------------------------------------------

function planTone(p: number | null): string {
  if (p === null) return "text-slate-900";
  if (p > 100) return "text-emerald-700";
  if (p >= 80) return "text-amber-700";
  return "text-rose-700";
}

function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-500">{label}</div>
      <div className={`mt-2 truncate text-2xl font-semibold ${accent ?? "text-slate-900"}`}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
      <span className="text-sm font-semibold text-slate-700">{title}</span>
      {right}
    </div>
  );
}

function TrendCard({ title, trend, noun, tone }: { title: string; trend: Trend; noun: string; tone: "emerald" | "rose" | "brand" }) {
  const changeCls = trend.changePercent === null ? "text-slate-500" : trend.changePercent >= 0 ? "text-emerald-700" : "text-rose-700";
  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <SectionHeader
        title={title}
        right={
          <span className="flex items-center gap-3 text-xs">
            <span className="text-slate-500">Текущий: <span className="font-medium text-slate-900">{formatKopeks(trend.currentKopeks)}</span></span>
            <span className="text-slate-500">Прошлый: <span className="font-medium text-slate-900">{formatKopeks(trend.previousKopeks)}</span></span>
            <span className={`font-semibold ${changeCls}`}>{trend.changePercent === null ? "—" : `${trend.changePercent >= 0 ? "+" : ""}${trend.changePercent.toFixed(0)}%`}</span>
          </span>
        }
      />
      <BarChart bars={trend.buckets.map((b) => ({ label: b.label, subLabel: b.subLabel, value: b.valueKopeks }))} tone={tone} />
      <div className="border-t border-slate-100 px-4 py-2 text-sm text-slate-600">{changeSentence(noun, trend.changePercent)}</div>
    </div>
  );
}

function ClubRankingBlock({ rows }: { rows: ClubRankRow[] }) {
  const bestId = rows[0]?.clubId;
  const worstId = rows.length > 1 ? rows[rows.length - 1].clubId : undefined;
  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <SectionHeader title="Рейтинг клубов" />
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            <Th>Клуб</Th>
            <Th className="text-right">Продажи</Th>
            <Th className="text-right">Расходы</Th>
            <Th className="text-right">Прибыль</Th>
            <Th className="text-right">План %</Th>
            <Th className="text-right">Бюджет %</Th>
            <Th className="text-right">Место</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((r, i) => (
            <tr key={r.clubId} className="hover:bg-slate-50">
              <Td className="font-medium text-slate-900">
                <span className="mr-1">{r.clubId === bestId ? "🥇" : r.clubId === worstId ? "🔻" : ""}</span>
                {r.clubName}
              </Td>
              <Td className="text-right">{formatKopeks(r.salesKopeks)}</Td>
              <Td className="text-right">{formatKopeks(r.expensesKopeks)}</Td>
              <Td className={`text-right font-medium ${r.profitKopeks >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{formatKopeks(r.profitKopeks)}</Td>
              <Td className="text-right">{pct(r.planPercent)}</Td>
              <Td className={`text-right ${r.budgetPercent !== null && r.budgetPercent > 100 ? "text-rose-700" : ""}`}>{pct(r.budgetPercent)}</Td>
              <Td className="text-right text-slate-500">{i + 1}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanPerformanceBlock({ rows }: { rows: PlanPerfRow[] }) {
  const statusMeta: Record<string, { label: string; cls: string }> = {
    ahead: { label: "🟢 Перевыполнен", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
    near: { label: "🟡 Близко к плану", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
    behind: { label: "🔴 Отставание", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  };
  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <SectionHeader title="Выполнение плана продаж" />
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">Планы продаж не заданы.</div>
      ) : (
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Клуб</Th>
              <Th className="text-right">План</Th>
              <Th className="text-right">Факт</Th>
              <Th className="text-right">Разница</Th>
              <Th className="text-right">Выполнение</Th>
              <Th>Статус</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((r) => {
              const meta = statusMeta[r.status];
              const diffCls = r.differenceKopeks >= 0 ? "text-emerald-700" : "text-rose-700";
              return (
                <tr key={r.clubId} className="hover:bg-slate-50">
                  <Td className="font-medium text-slate-900">{r.clubName}</Td>
                  <Td className="text-right">{r.planKopeks > 0 ? formatKopeks(r.planKopeks) : "—"}</Td>
                  <Td className="text-right">{formatKopeks(r.factKopeks)}</Td>
                  <Td className={`text-right font-medium ${diffCls}`}>{r.differenceKopeks >= 0 ? "+" : "−"}{formatKopeks(Math.abs(r.differenceKopeks))}</Td>
                  <Td className="text-right font-medium text-slate-900">{pct(r.completionPercent)}</Td>
                  <Td>
                    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.cls}`}>{meta.label}</span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PlanSplitBlock({ rows }: { rows: PlanSplitClubRow[] }) {
  const groupTh = "px-4 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500 border-l border-slate-200";
  const subTh = "px-4 py-2 text-right text-[11px] font-medium text-slate-400";
  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <SectionHeader title="План и факт по направлениям" />
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">Планы по направлениям не заданы.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th rowSpan={2} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Клуб</th>
                <th colSpan={3} className={groupTh}>Общий</th>
                <th colSpan={3} className={groupTh}>Абонементы</th>
                <th colSpan={3} className={groupTh}>Персональные</th>
              </tr>
              <tr>
                {["план", "факт", "%", "план", "факт", "%", "план", "факт", "%"].map((h, i) => (
                  <th key={i} className={`${subTh}${i % 3 === 0 ? " border-l border-slate-200" : ""}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((r) => {
                const cells = [r.total, r.subscriptions, r.personal_training].flatMap((c, gi) => [
                  <Td key={`${gi}-p`} className={`text-right text-slate-500${gi > 0 ? " border-l border-slate-100" : ""}`}>{c.planKopeks > 0 ? formatKopeks(c.planKopeks) : "—"}</Td>,
                  <Td key={`${gi}-f`} className="text-right">{formatKopeks(c.factKopeks)}</Td>,
                  <Td key={`${gi}-pct`} className={`text-right font-medium ${planTone(c.percent)}`}>{pct(c.percent)}</Td>,
                ]);
                return (
                  <tr key={r.clubId} className="hover:bg-slate-50">
                    <Td className="font-medium text-slate-900">{r.clubName}</Td>
                    {cells}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WeekdaySalesBlock({ rows }: { rows: WeekdayRow[] }) {
  const hasData = rows.some((r) => r.reportCount > 0);
  const dash = (k: number, count: number) => (count > 0 ? formatKopeks(k) : "—");
  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <SectionHeader title="Продажи по дням недели" right={<BestBadge text="Лучший день по средней выручке" />} />
      {!hasData ? (
        <div className="px-4 py-10 text-center text-sm text-slate-500">Нет данных за период</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>День недели</Th>
                <Th className="text-right">Отчётов</Th>
                <Th className="text-right">Общая выручка</Th>
                <Th className="text-right">Средняя общая</Th>
                <Th className="text-right">Абонементы</Th>
                <Th className="text-right">Средняя АБ</Th>
                <Th className="text-right">Персональные</Th>
                <Th className="text-right">Средняя ПТ</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((r) => (
                <tr key={r.weekday} className={r.isBest ? "bg-emerald-50/60" : "hover:bg-slate-50"}>
                  <Td className="font-medium text-slate-900">
                    {r.isBest ? <span className="mr-1" title="Лучший день по средней выручке">🏆</span> : null}
                    {r.label}
                  </Td>
                  <Td className="text-right text-slate-600">{r.reportCount}</Td>
                  <Td className="text-right text-slate-900">{dash(r.totalKopeks, r.reportCount)}</Td>
                  <Td className="text-right font-medium text-slate-900">{dash(r.avgTotalKopeks, r.reportCount)}</Td>
                  <Td className="text-right text-slate-600">{dash(r.subscriptionsKopeks, r.reportCount)}</Td>
                  <Td className="text-right text-slate-600">{dash(r.avgSubscriptionsKopeks, r.reportCount)}</Td>
                  <Td className="text-right text-slate-600">{dash(r.personalTrainingKopeks, r.reportCount)}</Td>
                  <Td className="text-right text-slate-600">{dash(r.avgPersonalTrainingKopeks, r.reportCount)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ManagerSalesBlock({ rows }: { rows: ManagerRow[] }) {
  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <SectionHeader title="Продажи по менеджерам" right={<BestBadge text="Лучший по средней выручке" />} />
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-slate-500">Нет данных за период</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Менеджер</Th>
                <Th className="text-right">Отчётов</Th>
                <Th className="text-right">Общая выручка</Th>
                <Th className="text-right">Средняя общая</Th>
                <Th className="text-right">Абонементы</Th>
                <Th className="text-right">Средняя АБ</Th>
                <Th className="text-right">Персональные</Th>
                <Th className="text-right">Средняя ПТ</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((r) => (
                <tr key={r.manager} className={r.isBest ? "bg-emerald-50/60" : "hover:bg-slate-50"}>
                  <Td className="font-medium text-slate-900">
                    {r.isBest ? <span className="mr-1" title="Лучший по средней выручке">🏆</span> : null}
                    {r.manager}
                  </Td>
                  <Td className="text-right text-slate-600">{r.reportCount}</Td>
                  <Td className="text-right text-slate-900">{formatKopeks(r.totalKopeks)}</Td>
                  <Td className="text-right font-medium text-slate-900">{formatKopeks(r.avgTotalKopeks)}</Td>
                  <Td className="text-right text-slate-600">{formatKopeks(r.subscriptionsKopeks)}</Td>
                  <Td className="text-right text-slate-600">{formatKopeks(r.avgSubscriptionsKopeks)}</Td>
                  <Td className="text-right text-slate-600">{formatKopeks(r.personalTrainingKopeks)}</Td>
                  <Td className="text-right text-slate-600">{formatKopeks(r.avgPersonalTrainingKopeks)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BestBadge({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
      🏆 {text}
    </span>
  );
}

function TopExpensesBlock({ rows }: { rows: TopExpenseRow[] }) {
  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <SectionHeader title="Топ расходов по статьям" />
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
                <Td className="font-medium text-slate-900">{r.label}</Td>
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
    </div>
  );
}

function CriticalZonesBlock({ zones }: { zones: CriticalZone[] }) {
  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">Критические зоны</div>
      {zones.length === 0 ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-inset ring-emerald-200">
          Критических зон нет
        </div>
      ) : (
        <ul className="space-y-2">
          {zones.map((z, i) => (
            <li
              key={i}
              className={`rounded-md px-3 py-2 text-sm ring-1 ring-inset ${z.tone === "red" ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-amber-50 text-amber-800 ring-amber-200"}`}
            >
              {z.text}
            </li>
          ))}
        </ul>
      )}
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
