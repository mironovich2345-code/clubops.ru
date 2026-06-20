import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getCurrentAccessContext,
  getUserClubs,
} from "@/lib/access";
import { canManageSalesPlans, canApproveMonthReopen, type Role } from "@/lib/auth";
import {
  resolvePeriod,
  loadAnalyticsData,
  buildAnalyticsReport,
} from "@/lib/analytics";
import {
  getSalesPlansForCompanyMonth,
  monthKey,
  normalizeMonth,
} from "@/lib/sales-plans";
import { getLatestBalancesByClub, type ClubBalances } from "@/lib/balance-snapshots";
import { getPendingReopenRequestsForCompany } from "@/lib/month-reopen";
import { loadPaymentObligationsForScope } from "@/lib/payment-obligations";
import { calculateBalanceForecast, balanceRiskLevel } from "@/lib/balance";
import { dayStart, addDays } from "@/lib/payments";
import { SalesPlanForm } from "./_components/SalesPlanForm";
import { SalesPlanImport } from "./_components/SalesPlanImport";
import { OwnerReopenApprovals, type ReopenRow } from "./_components/OwnerReopenApprovals";
import { openClubAnalytics } from "./actions";

export const dynamic = "force-dynamic";

const monthFormatter = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });

// Financial fields on a club card (Расходы, Окупаемость) are for owner /
// general_director / regional_director / accountant only. Managers (sales-only)
// and marketers see the sales-only card. Page access itself is unchanged.
const FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "accountant"]);

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

function planTone(pct: number | null): string {
  if (pct === null) return "bg-slate-300 dark:bg-slate-700";
  if (pct >= 100) return "bg-emerald-500";
  if (pct >= 80) return "bg-amber-500";
  return "bg-rose-500";
}

type ClubCard = {
  id: string;
  name: string;
  city: string;
  subsFact: number;
  subsPlan: number;
  subsPct: number | null;
  ptFact: number;
  ptPlan: number;
  ptPct: number | null;
  expensesKopeks: number;
  breakEvenKopeks: number;
  // Finance Control — real ООО/ИП balances + SEPARATE per-entity cash-gap risk.
  oooKopeks: number | null;
  ipKopeks: number | null;
  oooRisk: "low" | "high" | "unknown";
  ipRisk: "low" | "high" | "unknown";
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; closeMonth?: string }>;
}) {
  const user = await requirePageAccess("dashboard");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Дашборд" description="Обзор клубов" />;
  }
  const companyId = scope.company.id;
  const companyName = scope.company.name;

  const ctx = await getCurrentAccessContext();
  const roles = ctx?.effectiveRoles ?? [];
  const financials = roles.some((r) => FINANCIAL_ROLES.has(r));
  const canEditPlan = canManageSalesPlans(roles);

  const now = new Date();
  const monthLabel = capitalize(monthFormatter.format(now));

  // Owner-only: pending month-reopening requests to approve/reject.
  const canApproveReopen = canApproveMonthReopen(roles);
  const reopenRows: ReopenRow[] = canApproveReopen
    ? (await getPendingReopenRequestsForCompany(companyId)).map((r) => ({
        id: r.id,
        month: r.month,
        monthLabel: capitalize(monthFormatter.format(new Date(`${r.month}-01T00:00:00`))),
        reason: r.reason,
        requestedByName: r.requestedByName,
        requestedAt: r.requestedAt.toISOString(),
        clubName: r.clubName,
        companyName,
      }))
    : [];

  // Club list = every active club accessible to the user in this company,
  // regardless of the topbar's selected club. getUserClubs is the role-correct
  // scope: owner/GD -> all company clubs; regional -> assigned; manager -> own.
  const clubs = await getUserClubs(user.id, companyId);
  const clubIds = clubs.map((c) => c.id);

  // Per-club figures reuse the SAME source of truth as Analytics (current month),
  // so the cards match the Analytics page exactly.
  const period = resolvePeriod("current_month", now);
  const data = await loadAnalyticsData(companyId, clubIds, period);
  const report = buildAnalyticsReport(data, period, "day");

  const expensesByClub = new Map(report.clubRanking.map((r) => [r.clubId, r.expensesKopeks]));
  const splitByClub = new Map(report.planSplitByClub.map((r) => [r.clubId, r]));
  const budgetByClub = new Map<string, number>();
  for (const b of data.budgets) budgetByClub.set(b.clubId, (budgetByClub.get(b.clubId) ?? 0) + b.limitAmountKopeks);

  // Finance Control — per-club ООО/ИП balances (snapshots) + SEPARATE per-entity
  // cash-gap risk (30-day obligations split by legal entity; never merged).
  const balancesByClub: Map<string, ClubBalances> = financials ? await getLatestBalancesByClub(companyId, clubIds) : new Map();
  const oblByClub = new Map<string, { ooo: number; ip: number }>();
  if (financials) {
    const t0 = dayStart(now);
    const horizon = addDays(t0, 30);
    const { obligations: payObs } = await loadPaymentObligationsForScope({ companyId, clubIds, loadEnd: horizon });
    for (const o of payObs) {
      if (!o.dueDate || dayStart(o.dueDate) > horizon) continue;
      const row = oblByClub.get(o.clubId) ?? { ooo: 0, ip: 0 };
      if (o.legalEntityType === "ooo") row.ooo += o.amountKopeks;
      else if (o.legalEntityType === "ip") row.ip += o.amountKopeks;
      oblByClub.set(o.clubId, row);
    }
  }
  const riskFor = (balanceKopeks: number | null, obligationsKopeks: number) =>
    balanceRiskLevel(calculateBalanceForecast({ currentCashKopeks: balanceKopeks, obligationsKopeks }));

  const cards: ClubCard[] = clubs.map((c) => {
    const split = splitByClub.get(c.id);
    const bal = balancesByClub.get(c.id);
    const oooKopeks = bal?.oooKopeks ?? null;
    const ipKopeks = bal?.ipKopeks ?? null;
    const obl = oblByClub.get(c.id) ?? { ooo: 0, ip: 0 };
    const oooRisk = riskFor(oooKopeks, obl.ooo);
    const ipRisk = riskFor(ipKopeks, obl.ip);
    return {
      id: c.id,
      name: c.name,
      city: c.city,
      subsFact: split?.subscriptions.factKopeks ?? 0,
      subsPlan: split?.subscriptions.planKopeks ?? 0,
      subsPct: split?.subscriptions.percent ?? null,
      ptFact: split?.personal_training.factKopeks ?? 0,
      ptPlan: split?.personal_training.planKopeks ?? 0,
      ptPct: split?.personal_training.percent ?? null,
      expensesKopeks: expensesByClub.get(c.id) ?? 0,
      breakEvenKopeks: budgetByClub.get(c.id) ?? 0,
      oooKopeks,
      ipKopeks,
      oooRisk,
      ipRisk,
    };
  });

  // Days remaining in the current month, including today.
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = daysInMonth - now.getDate() + 1;

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <PageHeader title="Дашборд" description="Обзор клубов" />
        <div className="text-sm text-slate-500 dark:text-slate-400">{monthLabel}</div>
      </div>

      {canApproveReopen ? <OwnerReopenApprovals requests={reopenRows} /> : null}

      {cards.length === 0 ? (
        <div className={`px-4 py-16 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
          Нет доступных клубов
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {cards.map((c) => (
            <ClubOverviewCard key={c.id} card={c} financials={financials} daysLeft={daysLeft} />
          ))}
        </div>
      )}

      {/* Sales-plan management (general director). Month close / reopen no longer
          lives on the dashboard — it moved to the Chief Accountant workspace and
          the Owner approval block above. */}
      {canEditPlan ? (
        <ManagementSection
          companyId={companyId}
          canEditPlan={canEditPlan}
          clubs={clubs.map((c) => ({ id: c.id, name: c.name }))}
          defaultClubId={scope.club?.id ?? clubs[0]?.id ?? ""}
          searchParams={await searchParams}
          now={now}
        />
      ) : null}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- club overview card ----------------------------------------------------

type DailyTarget = { kind: "value"; perDayKopeks: number } | { kind: "done" } | { kind: "noplan" };

function dailyTarget(plan: number, fact: number, daysLeft: number): DailyTarget {
  if (plan <= 0) return { kind: "noplan" };
  const remaining = plan - fact;
  if (remaining <= 0) return { kind: "done" };
  if (daysLeft <= 0) return { kind: "value", perDayKopeks: remaining };
  return { kind: "value", perDayKopeks: Math.round(remaining / daysLeft) };
}

function dailyTargetLabel(t: DailyTarget): { text: string; cls: string } {
  if (t.kind === "noplan") return { text: "План не задан", cls: "text-slate-400 dark:text-slate-500" };
  if (t.kind === "done") return { text: "План выполнен", cls: "text-emerald-600 dark:text-emerald-400" };
  return { text: `${formatKopeks(t.perDayKopeks)} / день`, cls: "text-slate-700 dark:text-slate-200" };
}

function ClubOverviewCard({ card, financials, daysLeft }: { card: ClubCard; financials: boolean; daysLeft: number }) {
  const subsDaily = dailyTargetLabel(dailyTarget(card.subsPlan, card.subsFact, daysLeft));
  const ptDaily = dailyTargetLabel(dailyTarget(card.ptPlan, card.ptFact, daysLeft));
  return (
    <form action={openClubAnalytics.bind(null, card.id)} className="h-full">
      <button
        type="submit"
        className={`group flex h-full w-full flex-col p-5 text-left transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-500 dark:hover:border-brand-700 ${CARD}`}
      >
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">{card.city || "—"}</div>
            <div className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">{card.name}</div>
          </div>
          <span aria-hidden className="mt-1 shrink-0 text-slate-300 transition group-hover:text-brand-500 dark:text-slate-600">→</span>
        </div>

        {/* Sales metrics + plan bars */}
        <div className="grid grid-cols-2 gap-4">
          <MetricBlock label="Продажи АБ" value={card.subsFact} pct={card.subsPct} accent="text-emerald-600 dark:text-emerald-400" />
          <MetricBlock label="Продажи ПТ" value={card.ptFact} pct={card.ptPct} accent="text-sky-600 dark:text-sky-400" />
        </div>

        {/* Daily targets */}
        <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
          <div>
            <div className="text-slate-400 dark:text-slate-500">До плана в день · АБ</div>
            <div className={`mt-0.5 font-medium ${subsDaily.cls}`}>{subsDaily.text}</div>
          </div>
          <div>
            <div className="text-slate-400 dark:text-slate-500">До плана в день · ПТ</div>
            <div className={`mt-0.5 font-medium ${ptDaily.cls}`}>{ptDaily.text}</div>
          </div>
        </div>

        {/* Financial fields (hidden from manager/marketer) */}
        {financials ? (
          <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-slate-400 dark:text-slate-500">Расходы</div>
                <div className="mt-0.5 text-base font-semibold text-rose-600 dark:text-rose-400">{formatKopeks(card.expensesKopeks)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400 dark:text-slate-500">Окупаемость</div>
                <div className="mt-0.5 text-base font-semibold text-slate-700 dark:text-slate-200">
                  {card.breakEvenKopeks > 0 ? formatKopeks(card.breakEvenKopeks) : <span className="text-sm font-medium text-slate-400 dark:text-slate-500">Бюджет не задан</span>}
                </div>
              </div>
            </div>
            {/* Finance Control — per-entity balance + risk (ООО / ИП kept separate) */}
            <div className="mt-3 grid grid-cols-2 gap-4 text-xs">
              <EntityBalanceCell label="ООО" balanceKopeks={card.oooKopeks} risk={card.oooRisk} />
              <EntityBalanceCell label="ИП" balanceKopeks={card.ipKopeks} risk={card.ipRisk} />
            </div>
          </div>
        ) : null}
      </button>
    </form>
  );
}

function EntityBalanceCell({ label, balanceKopeks, risk }: { label: string; balanceKopeks: number | null; risk: "low" | "high" | "unknown" }) {
  const riskCls = risk === "high" ? "text-rose-600 dark:text-rose-400" : risk === "low" ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400 dark:text-slate-500";
  const riskText = risk === "unknown" ? "Нет данных" : risk === "high" ? "Высокий" : "Низкий";
  return (
    <div>
      <div className="text-slate-400 dark:text-slate-500">{label}</div>
      <div className="mt-0.5 font-medium text-slate-700 dark:text-slate-200">{balanceKopeks === null ? "нет данных" : formatKopeks(balanceKopeks)}</div>
      <div className={`mt-0.5 ${riskCls}`}>Риск: {riskText}</div>
    </div>
  );
}

function MetricBlock({ label, value, pct, accent }: { label: string; value: number; pct: number | null; accent: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-slate-400 dark:text-slate-500">{label}</div>
      <div className={`mt-0.5 truncate text-xl font-semibold tracking-tight ${accent}`}>{formatKopeks(value)}</div>
      <div className="mt-2 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className={`h-full rounded-full ${planTone(pct)}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
        </div>
        <span className="w-9 shrink-0 text-right text-[11px] font-medium text-slate-500 dark:text-slate-400">
          {pct === null ? "—" : `${pct.toFixed(0)}%`}
        </span>
      </div>
    </div>
  );
}

// --- preserved management tools --------------------------------------------

async function ManagementSection({
  companyId,
  canEditPlan,
  clubs,
  defaultClubId,
  searchParams,
  now,
}: {
  companyId: string;
  canEditPlan: boolean;
  clubs: { id: string; name: string }[];
  defaultClubId: string;
  searchParams: { month?: string; closeMonth?: string };
  now: Date;
}) {
  const planMonth = monthKey(now);
  const selectedPlanMonth = normalizeMonth(searchParams.month ?? "") ?? planMonth;

  const splitPlanRows = canEditPlan ? await getSalesPlansForCompanyMonth(companyId, selectedPlanMonth) : [];

  // Per-club plan rows for the bulk-import preview (GD plan management).
  const perClubPlan = new Map<string, { total: number; subscriptions: number; personal_training: number }>();
  for (const p of splitPlanRows) {
    if (!p.clubId) continue;
    const cur = perClubPlan.get(p.clubId) ?? { total: 0, subscriptions: 0, personal_training: 0 };
    if (p.planType === "total") cur.total = p.targetAmountKopeks;
    else if (p.planType === "subscriptions") cur.subscriptions = p.targetAmountKopeks;
    else if (p.planType === "personal_training") cur.personal_training = p.targetAmountKopeks;
    perClubPlan.set(p.clubId, cur);
  }
  const dash = (k: number) => (k > 0 ? formatKopeks(k) : "—");
  const planClubRows = clubs
    .filter((c) => perClubPlan.has(c.id))
    .map((c) => {
      const v = perClubPlan.get(c.id)!;
      return { clubName: c.name, month: selectedPlanMonth, total: dash(v.total), subscriptions: dash(v.subscriptions), personal: dash(v.personal_training) };
    });

  return (
    <div className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Управление</h2>

      {canEditPlan && clubs.length > 0 ? (
        <div className={`mt-4 p-4 ${CARD}`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Планы продаж · {capitalize(monthFormatter.format(new Date(`${selectedPlanMonth}-01T00:00:00`)))}
            </div>
            <form method="get" action="/dashboard" className="flex items-end gap-2">
              <label className="block">
                <span className="sr-only">Месяц</span>
                <input type="month" name="month" defaultValue={selectedPlanMonth} className="input" />
              </label>
              <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                Показать
              </button>
            </form>
          </div>
          <SalesPlanForm clubs={clubs} defaultClubId={defaultClubId} defaultMonth={selectedPlanMonth} />
          <SalesPlanImport rows={planClubRows} />
        </div>
      ) : null}
    </div>
  );
}
