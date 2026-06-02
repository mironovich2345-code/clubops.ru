import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth";
import { formatKopeks } from "@/lib/money";
import { getInvoicesForScope, summarize } from "@/lib/invoices";
import { getExpensesForScope, summarizeExpenses } from "@/lib/expenses";
import { getSalesForScope, summarizeSales } from "@/lib/sales";
import { getCurrentCompanyAndClub, getClubsInScope } from "@/lib/access";
import { NoCompanyState } from "@/components/NoCompanyState";
import {
  profitSummary,
  clubComparison,
  type ClubFinance,
  type ProfitSummary,
} from "@/lib/dashboard";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
});

const monthFormatter = new Intl.DateTimeFormat("ru-RU", {
  month: "long",
  year: "numeric",
});

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export default async function DashboardPage() {
  const user = await requirePageAccess("dashboard");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Дашборд" description="Состояние бизнеса" />;
  }

  const [clubs, invoices, expenses, sales] = await Promise.all([
    getClubsInScope(scope),
    getInvoicesForScope(scope),
    getExpensesForScope(scope),
    getSalesForScope(scope),
  ]);

  const now = new Date();
  const invoiceSummary = summarize(invoices);
  const salesSum = summarizeSales(sales, now);
  const expensesSum = summarizeExpenses(expenses, now);
  const profit = profitSummary(salesSum, expensesSum);
  const clubsFinance = clubComparison(clubs, sales, expenses, now);

  const topExpenseCategories = expensesSum.categoryTotals.slice(0, 5);
  const topSalesSources = salesSum.sourceTotals.slice(0, 5);

  const outstandingKopeks =
    invoiceSummary.unpaid.amountKopeks + invoiceSummary.overdue.amountKopeks;

  const alerts = buildAlerts({
    overdueCount: invoiceSummary.overdue.count,
    outstandingKopeks,
    expenseGrowthPercent: profit.expenseGrowthPercent,
    salesGrowthPercent: profit.salesGrowthPercent,
  });

  return (
    <div>
      <PageHeader
        title="Дашборд"
        description={`Состояние бизнеса · ${monthFormatter.format(now)}`}
      />

      {/* 1. KPI cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Продажи за месяц" value={formatKopeks(profit.currentSalesKopeks)} />
        <KpiCard label="Расходы за месяц" value={formatKopeks(profit.currentExpensesKopeks)} />
        <KpiCard
          label="Прибыль за месяц"
          value={formatKopeks(profit.currentProfitKopeks)}
          accent={profit.currentProfitKopeks >= 0 ? "text-emerald-700" : "text-rose-700"}
        />
        <KpiCard
          label="Изменение прибыли"
          value={`${profit.profitChangeKopeks > 0 ? "+" : ""}${formatKopeks(profit.profitChangeKopeks)}`}
          sub={`${formatPercent(profit.profitChangePercent)} к прошлому месяцу`}
          accent={
            profit.profitChangeKopeks > 0
              ? "text-emerald-700"
              : profit.profitChangeKopeks < 0
                ? "text-rose-700"
                : "text-slate-900"
          }
        />
      </div>

      {/* 2. Financial health + 6. Alerts */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <HealthBlock profit={profit} />
        <div className="lg:col-span-2">
          <AlertsBlock alerts={alerts} />
        </div>
      </div>

      {/* 3 + 4. Top categories / sources */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <BreakdownBlock
          title="Топ статей расходов"
          subtitle={monthFormatter.format(now)}
          rows={topExpenseCategories.map((c) => ({ label: c.category, amountKopeks: c.amountKopeks }))}
          totalKopeks={profit.currentExpensesKopeks}
          barClass="bg-rose-400"
          emptyText="Нет расходов в этом месяце."
        />
        <BreakdownBlock
          title="Топ источников продаж"
          subtitle={monthFormatter.format(now)}
          rows={topSalesSources.map((s) => ({ label: s.source, amountKopeks: s.amountKopeks }))}
          totalKopeks={profit.currentSalesKopeks}
          barClass="bg-emerald-400"
          emptyText="Нет продаж в этом месяце."
        />
      </div>

      {/* 5. Club comparison */}
      {clubs.length > 1 ? (
        <div className="mb-6">
          <ClubComparisonBlock rows={clubsFinance} />
        </div>
      ) : null}

      {/* 7. Recent activity */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <RecentBlock
          title="Последние продажи"
          items={sales.slice(0, 5).map((s) => ({
            id: s.id,
            primary: s.source,
            secondary: s.club.name,
            amountKopeks: s.amountKopeks,
            date: s.saleDate,
          }))}
          emptyText="Продаж пока нет."
        />
        <RecentBlock
          title="Последние расходы"
          items={expenses.slice(0, 5).map((e) => ({
            id: e.id,
            primary: e.category,
            secondary: e.vendorName ?? e.club.name,
            amountKopeks: e.amountKopeks,
            date: e.expenseDate,
          }))}
          emptyText="Расходов пока нет."
        />
        <RecentBlock
          title="Последние счета"
          items={invoices.slice(0, 5).map((i) => ({
            id: i.id,
            primary: i.counterpartyName,
            secondary: i.subject,
            amountKopeks: i.amountKopeks,
            date: i.createdAt,
          }))}
          emptyText="Счетов пока нет."
        />
      </div>
    </div>
  );
}

// --- Alerts ---------------------------------------------------------------

type Alert = { tone: "danger" | "warning"; text: string };

function buildAlerts({
  overdueCount,
  outstandingKopeks,
  expenseGrowthPercent,
  salesGrowthPercent,
}: {
  overdueCount: number;
  outstandingKopeks: number;
  expenseGrowthPercent: number | null;
  salesGrowthPercent: number | null;
}): Alert[] {
  const alerts: Alert[] = [];
  if (overdueCount > 0) {
    alerts.push({ tone: "danger", text: `Просроченных счетов: ${overdueCount}` });
  }
  if (outstandingKopeks > 0) {
    alerts.push({
      tone: "warning",
      text: `Неоплаченные счета на сумму ${formatKopeks(outstandingKopeks)}`,
    });
  }
  if (expenseGrowthPercent !== null && expenseGrowthPercent > 20) {
    alerts.push({
      tone: "warning",
      text: `Расходы выросли на ${expenseGrowthPercent.toFixed(1)}% к прошлому месяцу`,
    });
  }
  if (salesGrowthPercent !== null && salesGrowthPercent < -20) {
    alerts.push({
      tone: "danger",
      text: `Продажи упали на ${Math.abs(salesGrowthPercent).toFixed(1)}% к прошлому месяцу`,
    });
  }
  return alerts;
}

function AlertsBlock({ alerts }: { alerts: Alert[] }) {
  return (
    <div className="h-full rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">Уведомления</div>
      {alerts.length === 0 ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-inset ring-emerald-200">
          Всё в порядке — критичных сигналов нет.
        </div>
      ) : (
        <ul className="space-y-2">
          {alerts.map((alert, i) => (
            <li
              key={i}
              className={[
                "rounded-md px-3 py-2 text-sm ring-1 ring-inset",
                alert.tone === "danger"
                  ? "bg-rose-50 text-rose-700 ring-rose-200"
                  : "bg-amber-50 text-amber-800 ring-amber-200",
              ].join(" ")}
            >
              {alert.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Financial health -----------------------------------------------------

function HealthBlock({ profit }: { profit: ProfitSummary }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">Финансовое здоровье</div>
      <dl className="space-y-3">
        <HealthRow
          label="Маржа прибыли"
          value={formatPercent(profit.marginPercent)}
          accent={
            profit.marginPercent === null
              ? "text-slate-900"
              : profit.marginPercent >= 0
                ? "text-emerald-700"
                : "text-rose-700"
          }
        />
        <HealthRow
          label="Рост продаж"
          value={formatPercent(profit.salesGrowthPercent)}
          accent={growthAccent(profit.salesGrowthPercent, true)}
        />
        <HealthRow
          label="Рост расходов"
          value={formatPercent(profit.expenseGrowthPercent)}
          accent={growthAccent(profit.expenseGrowthPercent, false)}
        />
      </dl>
    </div>
  );
}

// For sales, growth is good (green); for expenses, growth is bad (red).
function growthAccent(value: number | null, growthIsGood: boolean): string {
  if (value === null || value === 0) return "text-slate-900";
  const positive = value > 0;
  const good = growthIsGood ? positive : !positive;
  return good ? "text-emerald-700" : "text-rose-700";
}

function HealthRow({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className={`text-sm font-semibold ${accent}`}>{value}</dd>
    </div>
  );
}

// --- Breakdown (top categories / sources) ---------------------------------

function BreakdownBlock({
  title,
  subtitle,
  rows,
  totalKopeks,
  barClass,
  emptyText,
}: {
  title: string;
  subtitle: string;
  rows: Array<{ label: string; amountKopeks: number }>;
  totalKopeks: number;
  barClass: string;
  emptyText: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
        <div className="text-sm font-semibold text-slate-700">{title}</div>
        <div className="text-xs text-slate-500">{subtitle}</div>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">{emptyText}</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((row) => {
            const percent = totalKopeks > 0 ? (row.amountKopeks / totalKopeks) * 100 : 0;
            return (
              <li key={row.label} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-700">{row.label}</span>
                  <span className="text-sm font-medium text-slate-900">
                    {formatKopeks(row.amountKopeks)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${barClass}`} style={{ width: `${percent}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// --- Club comparison ------------------------------------------------------

function ClubComparisonBlock({ rows }: { rows: ClubFinance[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
        Сравнение клубов · текущий месяц
      </div>
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-white">
          <tr>
            <Th>Клуб</Th>
            <Th className="text-right">Продажи</Th>
            <Th className="text-right">Расходы</Th>
            <Th className="text-right">Прибыль</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.clubId} className="hover:bg-slate-50">
              <Td className="font-medium text-slate-900">{row.clubName}</Td>
              <Td className="text-right">{formatKopeks(row.salesKopeks)}</Td>
              <Td className="text-right">{formatKopeks(row.expensesKopeks)}</Td>
              <Td
                className={`text-right font-medium ${
                  row.profitKopeks >= 0 ? "text-emerald-700" : "text-rose-700"
                }`}
              >
                {formatKopeks(row.profitKopeks)}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Recent activity ------------------------------------------------------

function RecentBlock({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: Array<{
    id: string;
    primary: string;
    secondary: string;
    amountKopeks: number;
    date: Date;
  }>;
  emptyText: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
        {title}
      </div>
      {items.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">{emptyText}</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900">{item.primary}</div>
                <div className="truncate text-xs text-slate-500">{item.secondary}</div>
              </div>
              <div className="whitespace-nowrap text-right">
                <div className="text-sm font-medium text-slate-900">
                  {formatKopeks(item.amountKopeks)}
                </div>
                <div className="text-xs text-slate-400">{dateFormatter.format(item.date)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Small shared building blocks -----------------------------------------

function KpiCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-500">{label}</div>
      <div className={`mt-2 truncate text-2xl font-semibold ${accent ?? "text-slate-900"}`}>
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
