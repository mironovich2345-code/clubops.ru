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
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
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

  const data = await loadAnalyticsData(scope.company.id, ctx.allowedClubIds, period);
  const report = buildAnalyticsReport(data, period, granularity);
  const s = report.summary;

  const fromValue = sp.from ?? drillFrom;
  const toValue = sp.to ?? isoLocal(lastDay);
  // Part 3 — chart spans the side area only when the financial cards are present.
  const chartSpan = financials ? "lg:col-span-2" : "lg:col-span-4";

  return (
    <div className="mx-auto max-w-[1440px]">
      {/* Header + period selector */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <PageHeader title="Аналитика" description="Бизнес-обзор клуба" />
        <form method="get" className={`flex flex-wrap items-end gap-2 p-2 ${CARD}`}>
          <label className="block">
            <span className="mb-1 block px-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">Период</span>
            <select name="period" defaultValue={periodKey} className="input">
              {PERIOD_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block px-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">С даты</span>
            <input type="date" name="from" defaultValue={fromValue} className="input" />
          </label>
          <label className="block">
            <span className="mb-1 block px-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">По дату</span>
            <input type="date" name="to" defaultValue={toValue} className="input" />
          </label>
          <button type="submit" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-700">
            Показать
          </button>
        </form>
      </div>

      {/* Selected-period chip */}
      <div className="mb-5 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <span className="font-medium text-slate-700 dark:text-slate-200">{period.label}</span>
        <span className="text-slate-300 dark:text-slate-600">·</span>
        <span>{rangeLabel}</span>
      </div>

      {/* Part 2 — top KPI grid (2×2) with plan progress on the sales cards */}
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <KpiCard
          label="Продажи абонементов"
          value={formatKopeks(s.subscriptionsKopeks)}
          sub={rangeLabel}
          accent="text-emerald-600 dark:text-emerald-400"
          trend={{ cur: s.subscriptionsKopeks, prev: s.prevSubscriptionsKopeks, goodWhenUp: true }}
          progress={report.planTotals.subscriptions}
        />
        <KpiCard
          label="Продажи персональных тренировок"
          value={formatKopeks(s.personalTrainingKopeks)}
          sub={rangeLabel}
          accent="text-sky-600 dark:text-sky-400"
          trend={{ cur: s.personalTrainingKopeks, prev: s.prevPersonalTrainingKopeks, goodWhenUp: true }}
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
            <KpiCard
              label="Долги / обязательства"
              value={formatKopeks(s.obligationsKopeks)}
              sub="согласованные неоплаченные счета и возвраты"
              accent={s.obligationsKopeks > 0 ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100"}
            />
          </>
        ) : null}
      </div>

      {/* Part 3 — sales dynamics + profit + cash */}
      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className={`min-w-0 md:col-span-2 ${chartSpan}`}>
          <Panel title="Динамика продаж" hint={rangeLabel}>
            <SalesDynamicsChart buckets={report.salesSplitTrend.buckets} height={180} />
          </Panel>
        </div>
        {financials ? (
          <>
            <ProfitCard profit={s.profitKopeks} prev={s.prevProfitKopeks} sub={rangeLabel} />
            <CashCard oooKopeks={s.cashOooRemainingKopeks} />
          </>
        ) : null}
      </div>

      {/* Part 5 — lower analytics grid (sales left, expenses/forecast right) */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <ManagerSalesBlock rows={report.managerSales} />
          <WeekdaySalesBlock rows={report.weekdaySales} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {financials ? <TopExpensesBlock rows={report.topExpenses} from={drillFrom} to={drillTo} /> : null}
          <ForecastBlock />
        </div>
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
    <div className={`flex h-full flex-col p-5 ${CARD}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium leading-tight text-slate-500 dark:text-slate-400">{label}</div>
        {trend ? <TrendChip cur={trend.cur} prev={trend.prev} goodWhenUp={trend.goodWhenUp} /> : null}
      </div>
      <div className={`mt-3 truncate text-3xl font-semibold tracking-tight ${muted ? "text-slate-400 dark:text-slate-500" : accent ?? "text-slate-900 dark:text-slate-100"}`}>
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">{sub}</div> : null}
      {progress ? <PlanProgress cell={progress} /> : null}
    </div>
  );
}

function ProfitCard({ profit, prev, sub }: { profit: number; prev: number; sub: string }) {
  const accent = profit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  return (
    <div className={`flex h-full flex-col p-5 ${CARD}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-slate-500 dark:text-slate-400">Прибыль</div>
        <TrendChip cur={profit} prev={prev} goodWhenUp />
      </div>
      <div className={`mt-3 truncate text-3xl font-semibold tracking-tight ${accent}`}>{formatKopeks(profit)}</div>
      <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">{sub}</div>
    </div>
  );
}

function CashCard({ oooKopeks }: { oooKopeks: number }) {
  return (
    <div className={`flex h-full flex-col p-5 ${CARD}`}>
      <div className="text-sm font-medium text-slate-500 dark:text-slate-400">Наличные на клубе</div>
      <dl className="mt-3 space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-xs text-slate-400 dark:text-slate-500">ООО</dt>
          <dd className={`text-xl font-semibold tracking-tight ${oooKopeks < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-900 dark:text-slate-100"}`}>
            {formatKopeks(oooKopeks)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-xs text-slate-400 dark:text-slate-500">ИП</dt>
          <dd className="text-sm font-medium text-slate-400 dark:text-slate-500">скоро</dd>
        </div>
      </dl>
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

function ForecastBlock() {
  return (
    <div className={`flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 p-8 text-center dark:border-slate-700 dark:bg-slate-900`}>
      <div className="text-sm font-semibold text-slate-600 dark:text-slate-300">Прогноз</div>
      <div className="mx-auto mt-1 max-w-xs text-sm text-slate-400 dark:text-slate-500">Модуль прогнозирования будет подключён позже</div>
    </div>
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
