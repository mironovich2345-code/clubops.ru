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

// Period selector options (Part 1). `custom` reads the from/to date inputs.
const PERIOD_OPTIONS: { value: AnalyticsPeriodKey; label: string }[] = [
  { value: "current_week", label: "Текущая неделя" },
  { value: "previous_week", label: "Прошлая неделя" },
  { value: "current_month", label: "Текущий месяц" },
  { value: "previous_month", label: "Прошлый месяц" },
  { value: "current_year", label: "Текущий год" },
  { value: "previous_year", label: "Прошлый год" },
  { value: "custom", label: "Произвольный период" },
];

// Financial blocks (expenses, expense plan, cash balances, top expenses) are for
// financial roles only. Managers are sales-only and marketers have no financial
// view — both see only the sales blocks. Page access itself is unchanged.
const FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "accountant"]);

// Shared, dark-theme-ready surface classes (dormant `dark:` until a `.dark`
// ancestor exists — see tailwind.config darkMode: "class").
const CARD = "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

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
  // Local-date bounds for the expense drilldown links (exclusive end).
  const drillFrom = isoLocal(period.start);
  const drillTo = isoLocal(period.end);
  const lastDay = new Date(period.end.getTime() - 24 * 60 * 60 * 1000);
  const rangeLabel = `${dfmt.format(period.start)} – ${dfmt.format(lastDay)}`;

  const data = await loadAnalyticsData(scope.company.id, ctx.allowedClubIds, period);
  const report = buildAnalyticsReport(data, period, granularity);
  const s = report.summary;

  // Custom inputs default to the resolved window so switching to «Произвольный» is seamless.
  const fromValue = sp.from ?? drillFrom;
  const toValue = sp.to ?? isoLocal(lastDay);

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <PageHeader title="Аналитика" description="Бизнес-обзор клуба" />

        {/* Part 1 — period selector: dropdown + from + to + «Показать» */}
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
      <div className="mb-6 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <span className="font-medium text-slate-700 dark:text-slate-200">{period.label}</span>
        <span className="text-slate-300 dark:text-slate-600">·</span>
        <span>{rangeLabel}</span>
      </div>

      {/* BLOCK 1 — KPI cards (Part 3) */}
      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard label="Продажи абонементов" value={formatKopeks(s.subscriptionsKopeks)} sub={rangeLabel} accent="text-emerald-600 dark:text-emerald-400" trend={{ cur: s.subscriptionsKopeks, prev: s.prevSubscriptionsKopeks, goodWhenUp: true }} />
        <KpiCard label="Продажи персональных тренировок" value={formatKopeks(s.personalTrainingKopeks)} sub={rangeLabel} accent="text-sky-600 dark:text-sky-400" trend={{ cur: s.personalTrainingKopeks, prev: s.prevPersonalTrainingKopeks, goodWhenUp: true }} />
        {financials ? (
          <>
            <KpiCard label="Фактические расходы" value={formatKopeks(s.expensesKopeks)} sub={rangeLabel} accent="text-rose-600 dark:text-rose-400" trend={{ cur: s.expensesKopeks, prev: s.prevExpensesKopeks, goodWhenUp: false }} />
            <KpiCard
              label="План расходов"
              value={s.budgetTotalKopeks > 0 ? formatKopeks(s.budgetTotalKopeks) : "Не задан"}
              sub={s.budgetTotalKopeks > 0 ? rangeLabel : "бюджет не настроен"}
              muted={s.budgetTotalKopeks === 0}
            />
            <KpiCard
              label="Остаток наличности ООО"
              value={formatKopeks(s.cashOooRemainingKopeks)}
              sub="наличные ООО − инкассация"
              accent={s.cashOooRemainingKopeks < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-900 dark:text-slate-100"}
            />
            <KpiCard label="Остаток наличности ИП" value="Скоро" sub="модуль в разработке" muted />
          </>
        ) : null}
      </div>

      {/* BLOCK 2 — sales dynamics (Part 4) */}
      <Panel title="Динамика продаж" hint={rangeLabel}>
        <SalesDynamicsChart buckets={report.salesSplitTrend.buckets} />
      </Panel>

      {/* BLOCK 3 — sales by weekday (Part 5) */}
      <WeekdaySalesBlock rows={report.weekdaySales} />

      {/* BLOCK 4 — sales by manager (Part 5) */}
      <ManagerSalesBlock rows={report.managerSales} />

      {/* BLOCK 5 — top expense categories, financial roles only (Part 6) */}
      {financials ? <TopExpensesBlock rows={report.topExpenses} from={drillFrom} to={drillTo} /> : null}

      {/* BLOCK 6 — forecast placeholder (Part 7) */}
      <ForecastBlock />
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
    <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${cls}`} title="к предыдущему периоду">
      {flat ? "→" : up ? "↑" : "↓"} {Math.abs(d).toFixed(0)}%
    </span>
  );
}

function KpiCard({
  label,
  value,
  sub,
  accent,
  muted,
  trend,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  muted?: boolean;
  trend?: { cur: number; prev: number; goodWhenUp: boolean };
}) {
  return (
    <div className={`flex h-full flex-col justify-between p-5 ${CARD}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium leading-tight text-slate-500 dark:text-slate-400">{label}</div>
        {trend ? <TrendChip cur={trend.cur} prev={trend.prev} goodWhenUp={trend.goodWhenUp} /> : null}
      </div>
      <div className={`mt-3 truncate text-3xl font-semibold tracking-tight ${muted ? "text-slate-400 dark:text-slate-500" : accent ?? "text-slate-900 dark:text-slate-100"}`}>
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">{sub}</div> : null}
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={`mb-8 overflow-hidden ${CARD}`}>
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</span>
        {hint ? <span className="text-xs text-slate-400 dark:text-slate-500">{hint}</span> : null}
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
                  <Td className="font-medium text-slate-900 dark:text-slate-100">
                    {r.isBest ? <span className="mr-1" title="Лучший день по средней выручке">🏆</span> : null}
                    {r.label}
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
    <Panel title="Продажи по менеджерам" hint="🏆 — лучший по средней выручке за смену">
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
                <Th className="text-right">Средняя выручка за смену</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {rows.map((r) => (
                <tr key={r.manager} className={r.isBest ? "bg-emerald-50/60 dark:bg-emerald-500/10" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"}>
                  <Td className="font-medium text-slate-900 dark:text-slate-100">
                    {r.isBest ? <span className="mr-1" title="Лучший по средней выручке за смену">🏆</span> : null}
                    {r.manager}
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
    <Panel title="Топ расходов по статьям" hint="Нажмите статью для детализации →">
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">Расходов за период нет.</div>
      ) : (
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
                <Td className="w-40">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
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
    <div className="mb-8 flex flex-col items-center rounded-xl border border-dashed border-slate-300 bg-gradient-to-b from-slate-50 to-white p-10 text-center shadow-sm dark:border-slate-700 dark:from-slate-900 dark:to-slate-900">
      <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400">✨</div>
      <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">Прогноз</div>
      <div className="mx-auto mt-1 max-w-md text-sm text-slate-400 dark:text-slate-500">Модуль прогнозирования будет подключён позже</div>
    </div>
  );
}

function EmptyRow() {
  return <div className="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">Нет данных за период</div>;
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${className ?? ""}`}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
