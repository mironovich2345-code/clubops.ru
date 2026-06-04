import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { formatKopeks } from "@/lib/money";
import {
  getSalesForScope,
  summarizeSales,
  availableSaleActions,
  isConfirmedSale,
  SALE_STATUS_LABELS,
  type SaleSummary,
} from "@/lib/sales";
import { getCurrentCompanyAndClub, getClubsInScope } from "@/lib/access";
import { NoCompanyState } from "@/components/NoCompanyState";
import { CreateSaleForm } from "./_components/CreateSaleForm";
import { SaleRowActions } from "./_components/SaleRowActions";

const SALE_STATUS_TONE: Record<string, string> = {
  pending_accountant: "bg-amber-50 text-amber-800 ring-amber-200",
  confirmed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  rejected: "bg-rose-50 text-rose-700 ring-rose-200",
  canceled: "bg-slate-100 text-slate-600 ring-slate-200",
};

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "pending_accountant", label: "На проверке" },
  { key: "confirmed", label: "Подтверждено" },
  { key: "rejected", label: "Отклонено" },
];

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const monthFormatter = new Intl.DateTimeFormat("ru-RU", {
  month: "long",
  year: "numeric",
});

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requirePageAccess("sales");
  const ctx = await getCurrentAccessContext();

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company || !ctx) {
    return <NoCompanyState title="Продажи" description="Ручной учёт продаж и динамика выручки" />;
  }

  const [clubs, sales] = await Promise.all([
    getClubsInScope(scope),
    getSalesForScope(scope),
  ]);

  const now = new Date();
  // Revenue cards reflect only confirmed sales — pending/rejected are not revenue.
  const confirmedSales = sales.filter((s) => isConfirmedSale(s.status));
  const summary = summarizeSales(confirmedSales, now);
  const currentMonthLabel = monthFormatter.format(now);
  const previousMonthLabel = monthFormatter.format(
    new Date(now.getFullYear(), now.getMonth() - 1, 1),
  );

  const pendingSales = sales.filter((s) => s.status === "pending_accountant");
  const pendingKopeks = pendingSales.reduce((sum, s) => sum + s.amountKopeks, 0);

  const { status: statusParam } = await searchParams;
  const filter = FILTERS.some((f) => f.key === statusParam) ? statusParam! : "all";
  const visibleSales = filter === "all" ? sales : sales.filter((s) => s.status === filter);

  return (
    <div>
      <PageHeader title="Продажи" description="Ручной учёт продаж и динамика выручки" />

      <SummarySection
        summary={summary}
        currentMonthLabel={currentMonthLabel}
        previousMonthLabel={previousMonthLabel}
      />

      {pendingSales.length > 0 ? (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <span className="font-semibold text-amber-800">Продажи на проверке</span>
          <span className="font-medium text-amber-900">{formatKopeks(pendingKopeks)}</span>
          <span className="text-amber-700">· {pendingSales.length} шт.</span>
        </div>
      ) : null}

      <CreateSaleForm clubs={clubs} />

      {/* Status filters */}
      <div className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "all" ? "/sales" : `/sales?status=${f.key}`}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
              filter === f.key
                ? "border-brand-300 bg-brand-600 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Дата</Th>
                <Th>Источник</Th>
                <Th className="text-right">Сумма</Th>
                <Th>Статус</Th>
                <Th>Кто добавил</Th>
                <Th>Действия</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {visibleSales.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">
                    {sales.length === 0
                      ? "Пока нет продаж. Нажмите «Добавить продажу», чтобы создать первую."
                      : "Нет продаж с выбранным статусом."}
                  </td>
                </tr>
              ) : (
                visibleSales.map((sale) => {
                  const actions = availableSaleActions(
                    sale.status,
                    ctx.effectiveRoles,
                    sale.createdByUserId === ctx.user.id,
                  );
                  return (
                    <tr key={sale.id} className="hover:bg-slate-50">
                      <Td className="whitespace-nowrap">{dateFormatter.format(sale.saleDate)}</Td>
                      <Td>
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200">
                          {sale.source}
                        </span>
                        <div className="mt-1 text-xs text-slate-500">{sale.club.name}</div>
                      </Td>
                      <Td className="whitespace-nowrap text-right font-medium text-slate-900">
                        {formatKopeks(sale.amountKopeks)}
                      </Td>
                      <Td>
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                            SALE_STATUS_TONE[sale.status] ?? "bg-slate-100 text-slate-600 ring-slate-200"
                          }`}
                        >
                          {SALE_STATUS_LABELS[sale.status] ?? sale.status}
                        </span>
                        {sale.status === "rejected" && sale.rejectionReason ? (
                          <div className="mt-1 max-w-[16rem] text-xs text-slate-500">
                            {sale.rejectionReason}
                          </div>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap text-slate-600">{sale.createdBy.name}</Td>
                      <Td>
                        <SaleRowActions saleId={sale.id} actions={actions} />
                      </Td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <SourceAnalytics
          totals={summary.sourceTotals}
          totalKopeks={summary.currentMonthKopeks}
          monthLabel={currentMonthLabel}
        />
      </div>
    </div>
  );
}

function SummarySection({
  summary,
  currentMonthLabel,
  previousMonthLabel,
}: {
  summary: SaleSummary;
  currentMonthLabel: string;
  previousMonthLabel: string;
}) {
  // For revenue, growth is positive (green) and decline is negative (red).
  const changeUp = summary.changeKopeks > 0;
  const changeDown = summary.changeKopeks < 0;
  const changeAccent = changeUp
    ? "text-emerald-700"
    : changeDown
      ? "text-rose-700"
      : "text-slate-600";
  const sign = changeUp ? "+" : "";
  const percentText =
    summary.changePercent === null
      ? "нет данных за прошлый месяц"
      : `${sign}${summary.changePercent.toFixed(1)}% к прошлому месяцу`;

  return (
    <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card label="Выручка за месяц (подтверждённая)" sub={currentMonthLabel} accent="text-slate-900">
        {formatKopeks(summary.currentMonthKopeks)}
      </Card>
      <Card label="Прошлый месяц" sub={previousMonthLabel} accent="text-slate-900">
        {formatKopeks(summary.previousMonthKopeks)}
      </Card>
      <Card label="Изменение" sub={percentText} accent={changeAccent}>
        {`${sign}${formatKopeks(summary.changeKopeks)}`}
      </Card>
      <Card
        label="Главный источник"
        sub={
          summary.topSource
            ? formatKopeks(summary.topSource.amountKopeks)
            : "нет продаж в этом месяце"
        }
        accent="text-slate-900"
      >
        {summary.topSource ? summary.topSource.source : "—"}
      </Card>
    </div>
  );
}

function SourceAnalytics({
  totals,
  totalKopeks,
  monthLabel,
}: {
  totals: SaleSummary["sourceTotals"];
  totalKopeks: number;
  monthLabel: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
        <div className="text-sm font-semibold text-slate-700">Продажи по источникам</div>
        <div className="text-xs text-slate-500">{monthLabel}</div>
      </div>
      {totals.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">
          Нет продаж в этом месяце.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {totals.map((item) => {
            const percent = totalKopeks > 0 ? (item.amountKopeks / totalKopeks) * 100 : 0;
            return (
              <li key={item.source} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-700">{item.source}</span>
                  <span className="text-sm font-medium text-slate-900">
                    {formatKopeks(item.amountKopeks)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-brand-500"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="mt-1 text-right text-xs text-slate-400">
                  {percent.toFixed(1)}%
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Card({
  label,
  sub,
  accent,
  children,
}: {
  label: string;
  sub: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-500">{label}</div>
      <div className={`mt-2 truncate text-2xl font-semibold ${accent}`}>{children}</div>
      <div className="mt-1 text-xs text-slate-500">{sub}</div>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
