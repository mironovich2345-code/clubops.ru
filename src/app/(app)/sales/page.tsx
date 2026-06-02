import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth";
import { ensureDemoData } from "@/lib/seed";
import { formatKopeks } from "@/lib/money";
import { getClubsForUser } from "@/lib/invoices";
import { getSalesForUser, summarizeSales, type SaleSummary } from "@/lib/sales";
import { CreateSaleForm } from "./_components/CreateSaleForm";

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

export default async function SalesPage() {
  const user = await requirePageAccess("sales");
  await ensureDemoData();

  const [clubs, sales] = await Promise.all([
    getClubsForUser(user),
    getSalesForUser(user),
  ]);

  const now = new Date();
  const summary = summarizeSales(sales, now);
  const currentMonthLabel = monthFormatter.format(now);
  const previousMonthLabel = monthFormatter.format(
    new Date(now.getFullYear(), now.getMonth() - 1, 1),
  );

  return (
    <div>
      <PageHeader title="Продажи" description="Ручной учёт продаж и динамика выручки" />

      <SummarySection
        summary={summary}
        currentMonthLabel={currentMonthLabel}
        previousMonthLabel={previousMonthLabel}
      />

      <CreateSaleForm clubs={clubs} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Дата</Th>
                <Th>Источник</Th>
                <Th className="text-right">Сумма</Th>
                <Th>Комментарий</Th>
                <Th>Кто добавил</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {sales.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-500">
                    Пока нет продаж. Нажмите «Добавить продажу», чтобы создать первую.
                  </td>
                </tr>
              ) : (
                sales.map((sale) => (
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
                    <Td className="max-w-xs">
                      <div className="line-clamp-2 text-slate-600">{sale.comment ?? "—"}</div>
                    </Td>
                    <Td className="whitespace-nowrap text-slate-600">{sale.createdBy.name}</Td>
                  </tr>
                ))
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
      <Card label="Продажи за месяц" sub={currentMonthLabel} accent="text-slate-900">
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
