import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { formatKopeks } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { OfdRevenueTable } from "../../settings/integrations/ofd/_components/OfdForms";
import {
  totalForRange,
  aggByClub,
  aggByLegalEntity,
  aggCategories,
  buildCategoryDetails,
  ymdLocal,
  currentMonth,
  shiftMonth,
  clampMonth,
  monthBounds,
  type OfdMoneyAgg,
} from "@/lib/ofd/analytics";

export const dynamic = "force-dynamic";

const monthFmt = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return monthFmt.format(new Date(y, m - 1, 1));
}

export default async function OfdSalesAnalyticsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  // Financial ОФД analytics is owner / general_director / regional_director only —
  // enforced by the ofd_sales page-access grant (managers/accountants redirected).
  await requirePageAccess("ofd_sales");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) redirect("/dashboard");
  const companyId = ctx.selectedCompanyId;
  // Scope to the clubs this user may see (regional_director → only their clubs).
  const clubIds = ctx.allowedClubIds;

  const now = new Date();
  const curMonth = currentMonth(now);
  const sp = await searchParams;
  const month = clampMonth(sp.month, curMonth);
  const { from: monthFrom, to: monthTo } = monthBounds(month);
  const today = ymdLocal(now);
  const yesterday = ymdLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  const hasScope = clubIds.length > 0;
  const [clubs, entities, summaries, categorySummaries, detailItems] = hasScope
    ? await Promise.all([
        prisma.club.findMany({ where: { companyId, id: { in: clubIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
        prisma.legalEntity.findMany({ where: { companyId }, select: { id: true, name: true } }),
        prisma.ofdDailySalesSummary.findMany({
          where: { companyId, provider: "taxcom", clubId: { in: clubIds } },
          select: { clubId: true, legalEntityId: true, date: true, incomeTotalKopeks: true, incomeCashKopeks: true, incomeElectronicKopeks: true, returnTotalKopeks: true, netTotalKopeks: true, receiptCount: true, returnReceiptCount: true },
        }),
        prisma.ofdRevenueCategoryDailySummary.findMany({
          where: { companyId, provider: "taxcom", clubId: { in: clubIds }, date: { startsWith: month } },
          select: { categoryCode: true, incomeTotalKopeks: true, returnTotalKopeks: true, netTotalKopeks: true, itemCount: true, receiptCount: true },
        }),
        prisma.ofdReceiptItem.findMany({
          where: { companyId, provider: "taxcom", clubId: { in: clubIds }, date: { startsWith: month } },
          select: { revenueCategoryCode: true, normalizedItemName: true, itemName: true, totalKopeks: true, operationType: true, receiptImportId: true },
        }),
      ])
    : [[], [], [], [], []];

  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const legalName = new Map(entities.map((e) => [e.id, e.name]));

  const todayAgg = totalForRange(summaries, today, today);
  const yesterdayAgg = totalForRange(summaries, yesterday, yesterday);
  const monthAgg = totalForRange(summaries, monthFrom, monthTo);
  const byClub = [...aggByClub(summaries, monthFrom, monthTo).entries()].sort((a, b) => b[1].net - a[1].net);
  const byLegal = [...aggByLegalEntity(summaries, monthFrom, monthTo).entries()].sort((a, b) => b[1].net - a[1].net);
  const categoryRows = aggCategories(categorySummaries);
  const categoryDetails = buildCategoryDetails(detailItems);

  const prevMonth = shiftMonth(month, -1);
  const nextMonth = shiftMonth(month, 1);
  const canGoNext = nextMonth <= curMonth;
  const monthHasData = monthAgg.income > 0 || monthAgg.ret > 0 || byClub.length > 0;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="ОФД-продажи" description="Детализация и сверка чеков ОФД: наличные, безнал, ОФД-возвраты (фискальные коррекции по кассе — не клиентские возвраты), юрлица и статьи доходов." />

      {/* Today / yesterday / selected-month cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SalesCard title="Сегодня" agg={todayAgg} />
        <SalesCard title="Вчера" agg={yesterdayAgg} />
        <SalesCard title={monthLabel(month)} agg={monthAgg} highlight />
      </div>

      {/* Month switcher */}
      <div className="mb-6 flex items-center gap-2 text-sm">
        <Link href={`/analytics/ofd-sales?month=${prevMonth}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50">← {monthLabel(prevMonth)}</Link>
        <span className="rounded-md bg-slate-100 px-3 py-1.5 font-medium text-slate-700">{monthLabel(month)}</span>
        {canGoNext ? (
          <Link href={`/analytics/ofd-sales?month=${nextMonth}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50">{monthLabel(nextMonth)} →</Link>
        ) : (
          <span className="rounded-md border border-slate-200 px-3 py-1.5 font-medium text-slate-300">следующий месяц →</span>
        )}
      </div>

      {!monthHasData ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500 shadow-sm">
          Нет продаж ОФД за {monthLabel(month)}.
        </div>
      ) : (
        <>
          <Block title="По клубам">
            <MoneyTable firstHeader="Клуб" rows={byClub.map(([id, a]) => ({ label: clubName.get(id) ?? "—", agg: a }))} />
          </Block>

          <Block title="По юрлицам">
            <MoneyTable firstHeader="Юрлицо" rows={byLegal.map(([key, a]) => ({ label: key === "none" ? "Без юрлица" : legalName.get(key) ?? "—", agg: a }))} />
          </Block>

          <Block title="Статьи доходов">
            {categoryRows.length === 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Номенклатура за {monthLabel(month)} пока недоступна: чеки есть, но позиции товаров/услуг ещё не получены.
              </div>
            ) : (
              <OfdRevenueTable rows={categoryRows} details={categoryDetails} />
            )}
          </Block>
        </>
      )}
    </div>
  );
}

function SalesCard({ title, agg, highlight }: { title: string; agg: OfdMoneyAgg; highlight?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 shadow-sm ${highlight ? "border-brand-200 bg-brand-50/40" : "border-slate-200 bg-white"}`}>
      <div className="text-sm font-medium capitalize text-slate-500">{title}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{formatKopeks(agg.income)}</div>
      <dl className="mt-3 space-y-1 text-sm">
        <Row label="Наличные" value={formatKopeks(agg.cash)} />
        <Row label="Безнал" value={formatKopeks(agg.electronic)} />
        <Row label="ОФД-возвраты" value={formatKopeks(agg.ret)} />
        <Row label="Чеков" value={String(agg.receipts)} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="mb-3 text-sm font-semibold text-slate-700">{title}</h2>
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">{children}</div>
    </div>
  );
}

function MoneyTable({ firstHeader, rows }: { firstHeader: string; rows: { label: string; agg: OfdMoneyAgg }[] }) {
  if (rows.length === 0) {
    return <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">Нет данных.</div>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr><Th>{firstHeader}</Th><Th>Наличные</Th><Th>Безнал</Th><Th>ОФД-возвраты</Th><Th>Итого</Th><Th>Чеков</Th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((r, i) => (
            <tr key={i}>
              <Td>{r.label}</Td>
              <Td>{formatKopeks(r.agg.cash)}</Td>
              <Td>{formatKopeks(r.agg.electronic)}</Td>
              <Td>{formatKopeks(r.agg.ret)}</Td>
              <Td className="font-medium text-slate-900">{formatKopeks(r.agg.net)}</Td>
              <Td>{r.agg.receipts}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2 align-top text-slate-700 ${className ?? ""}`}>{children}</td>;
}
