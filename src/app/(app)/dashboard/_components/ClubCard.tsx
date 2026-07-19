import Link from "next/link";
import { formatKopeks } from "@/lib/money";
import { computeManagementResult } from "@/lib/analytics/ofd-management";
import type { ClubCard as ClubCardData } from "@/lib/dashboard-cards";

// Club-cards overview for the dashboard: one clickable card per club with only the
// key figures (ОФД revenue + Абонементы/ПТ, расходы, наличные ООО/ИП, результат),
// gated per role. A click opens /analytics scoped to that club + month. Neutral,
// dark-safe tokens; soft accents. No SalesReport, no big OFD tables.
export type ClubCardsGridProps = {
  cards: ClubCardData[];
  showSales: boolean;   // ОФД membership / ПТ / revenue / result (owner/GD/regional)
  showExpenses: boolean; // confirmed expenses + result (financial roles)
  showCash: boolean;     // ООО / ИП fact cash (owner/GD/regional/manager)
  daysLeft: number;      // remaining days in the selected month (plan pacing)
  showCompany?: boolean; // show company name on each card (multi-company scope)
  linkFrom: string;      // /analytics period=custom bounds (YYYY-MM-DD)
  linkTo: string;
};

export function ClubCardsGrid(p: ClubCardsGridProps) {
  if (!p.showSales && !p.showExpenses && !p.showCash) {
    return (
      <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        Финансовые показатели для вашей роли не отображаются.
      </div>
    );
  }
  if (p.cards.length === 0) {
    return (
      <div className="mb-5 rounded-2xl border border-slate-200 bg-white px-4 py-16 text-center text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        Нет доступных клубов
      </div>
    );
  }
  return (
    <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
      {p.cards.map((c) => (
        <ClubCard key={c.id} card={c} showSales={p.showSales} showExpenses={p.showExpenses} showCash={p.showCash} daysLeft={p.daysLeft} showCompany={p.showCompany} linkFrom={p.linkFrom} linkTo={p.linkTo} />
      ))}
    </div>
  );
}

function planTone(pct: number | null): string {
  if (pct === null) return "bg-slate-300 dark:bg-slate-700";
  if (pct >= 100) return "bg-emerald-500/80";
  if (pct >= 80) return "bg-amber-400/80";
  return "bg-rose-400/80";
}

function ClubCard({ card, showSales, showExpenses, showCash, daysLeft, showCompany, linkFrom, linkTo }: { card: ClubCardData; showSales: boolean; showExpenses: boolean; showCash: boolean; daysLeft: number; showCompany?: boolean; linkFrom: string; linkTo: string }) {
  const subs = card.ofd.ofdSubscriptionsKopeks;
  const pt = card.ofd.ofdPersonalTrainingKopeks;
  const subsPct = card.subsPlan > 0 ? (subs / card.subsPlan) * 100 : null;
  const ptPct = card.ptPlan > 0 ? (pt / card.ptPlan) * 100 : null;
  const resultKopeks = computeManagementResult(card.ofd.ofdNetKopeks, card.expensesKopeks);
  // /analytics scoped to this club + the selected month (existing period=custom
  // format). Scope is re-checked server-side; a foreign clubId is ignored there.
  const href = `/analytics?clubId=${encodeURIComponent(card.id)}&companyId=${encodeURIComponent(card.companyId)}&scopeMode=company&period=custom&from=${linkFrom}&to=${linkTo}`;

  return (
    <Link href={href} className="group flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-brand-700">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {showCompany && card.companyName ? `${card.companyName} · ` : ""}{card.city || "—"}
          </div>
          <div className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">{card.name}</div>
        </div>
        <span aria-hidden className="mt-1 shrink-0 text-slate-300 transition group-hover:text-brand-500 dark:text-slate-600">→</span>
      </div>

      {showSales && card.ofd.ofdHasData ? (
        <div className="mb-3">
          <div className="text-xs text-slate-400 dark:text-slate-500">Выручка ОФД</div>
          <div className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{formatKopeks(card.ofd.ofdRevenueKopeks)}</div>
        </div>
      ) : null}

      {showSales ? (
        <div className="grid grid-cols-2 gap-4">
          <MetricBlock label="Абонементы" value={subs} pct={subsPct} plan={card.subsPlan} daysLeft={daysLeft} accent="text-emerald-600 dark:text-emerald-400" />
          <MetricBlock label="ПТ" value={pt} pct={ptPct} plan={card.ptPlan} daysLeft={daysLeft} accent="text-sky-600 dark:text-sky-400" />
        </div>
      ) : null}

      {showExpenses || (showSales && showExpenses) || showCash ? (
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-slate-100 pt-3 text-sm dark:border-slate-800">
          {showExpenses ? <Cell label="Фактические расходы" value={formatKopeks(card.expensesKopeks)} accent="text-rose-600 dark:text-rose-400" /> : null}
          {showSales && showExpenses ? <Cell label="Результат" value={formatKopeks(resultKopeks)} accent={resultKopeks >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"} /> : null}
          {showCash ? <Cell label="Наличные ООО" value={formatKopeks(card.oooFactKopeks)} /> : null}
          {showCash ? <Cell label="Наличные ИП" value={formatKopeks(card.ipFactKopeks)} /> : null}
        </div>
      ) : null}
    </Link>
  );
}

function MetricBlock({ label, value, pct, plan, daysLeft, accent }: { label: string; value: number; pct: number | null; plan: number; daysLeft: number; accent: string }) {
  const perDay = plan <= 0 ? "План не задан" : value >= plan ? "План выполнен" : daysLeft > 0 ? `${formatKopeks(Math.round((plan - value) / daysLeft))} / день` : `осталось ${formatKopeks(plan - value)}`;
  return (
    <div className="min-w-0">
      <div className="text-xs text-slate-400 dark:text-slate-500">{label}</div>
      <div className={`mt-0.5 truncate text-xl font-semibold tracking-tight ${accent}`}>{formatKopeks(value)}</div>
      <div className="mt-2 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className={`h-full rounded-full ${planTone(pct)}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
        </div>
        <span className="w-9 shrink-0 text-right text-[11px] font-medium text-slate-500 dark:text-slate-400">{pct === null ? "—" : `${pct.toFixed(0)}%`}</span>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-slate-400 dark:text-slate-500">{perDay}</div>
    </div>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-slate-400 dark:text-slate-500">{label}</div>
      <div className={`mt-0.5 truncate font-semibold ${accent ?? "text-slate-800 dark:text-slate-100"}`}>{value}</div>
    </div>
  );
}
