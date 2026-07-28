import { redirect } from "next/navigation";
import { CompactPageHeader, DataSummaryCard, MobileDataCard, SectionHeader, EmptyState } from "@/components/mobile/density";
import { MonthNav } from "@/components/mobile/MonthNav";
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
      <CompactPageHeader title="ОФД-продажи" subtitle="Детализация и сверка чеков ОФД: наличные, безнал, ОФД-возвраты (фискальные коррекции по кассе — не клиентские возвраты), юрлица и статьи доходов." />

      {/* Today / yesterday / selected-month — compact summary cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SalesCard title="Сегодня" agg={todayAgg} />
        <SalesCard title="Вчера" agg={yesterdayAgg} />
        <SalesCard title={monthLabel(month)} agg={monthAgg} highlight />
      </div>

      {/* Shared month navigator */}
      <div className="mt-4">
        <MonthNav prevHref={`/analytics/ofd-sales?month=${prevMonth}`} nextHref={canGoNext ? `/analytics/ofd-sales?month=${nextMonth}` : null} label={monthLabel(month)} />
      </div>

      {!monthHasData ? (
        <div className="mt-4"><EmptyState>Нет продаж ОФД за {monthLabel(month)}.</EmptyState></div>
      ) : (
        <>
          <SectionHeader>По клубам</SectionHeader>
          <MoneyBreakdown firstHeader="Клуб" rows={byClub.map(([id, a]) => ({ label: clubName.get(id) ?? "—", agg: a }))} />

          <SectionHeader>По юрлицам</SectionHeader>
          <MoneyBreakdown firstHeader="Юрлицо" rows={byLegal.map(([key, a]) => ({ label: key === "none" ? "Без юрлица" : legalName.get(key) ?? "—", agg: a }))} />

          <SectionHeader>Статьи доходов</SectionHeader>
          {categoryRows.length === 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Номенклатура за {monthLabel(month)} пока недоступна: чеки есть, но позиции товаров/услуг ещё не получены.
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"><OfdRevenueTable rows={categoryRows} details={categoryDetails} /></div>
          )}
        </>
      )}
    </div>
  );
}

function SalesCard({ title, agg, highlight }: { title: string; agg: OfdMoneyAgg; highlight?: boolean }) {
  return (
    <DataSummaryCard
      title={<span className="capitalize">{title}</span>}
      badge={highlight ? <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">Месяц</span> : undefined}
      rows={[
        { label: "Итого", value: formatKopeks(agg.income), strong: true },
        { label: "Наличные", value: formatKopeks(agg.cash) },
        { label: "Безнал", value: formatKopeks(agg.electronic) },
        { label: "ОФД-возвраты", value: formatKopeks(agg.ret) },
        { label: "Чеков", value: String(agg.receipts) },
      ]}
    />
  );
}

// Desktop table (≥lg) + mobile cards (spec §9/§10) — no compressed table on mobile.
function MoneyBreakdown({ firstHeader, rows }: { firstHeader: string; rows: { label: string; agg: OfdMoneyAgg }[] }) {
  if (rows.length === 0) return <EmptyState>Нет данных.</EmptyState>;
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-slate-200 lg:block">
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
      <div className="space-y-3 lg:hidden">
        {rows.map((r, i) => (
          <MobileDataCard
            key={i}
            title={r.label}
            rows={[
              { label: "Наличные", value: formatKopeks(r.agg.cash) },
              { label: "Безнал", value: formatKopeks(r.agg.electronic) },
              { label: "ОФД-возвраты", value: formatKopeks(r.agg.ret) },
              { label: "Чеков", value: String(r.agg.receipts) },
            ]}
            footer={<div className="flex items-baseline justify-between gap-2 text-sm"><span className="text-slate-500">Итого</span><span className="font-semibold tabular-nums text-slate-900">{formatKopeks(r.agg.net)}</span></div>}
          />
        ))}
      </div>
    </>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2 align-top text-slate-700 ${className ?? ""}`}>{children}</td>;
}
