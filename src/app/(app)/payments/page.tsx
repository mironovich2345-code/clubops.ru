import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks, formatKopeksShort } from "@/lib/money";
import { requirePageAccess, getCurrentCompanyAndClub, getCurrentAccessContext } from "@/lib/access";
import { isStrategicRole } from "@/lib/auth";
import { resolveStrategicGroups } from "@/lib/strategic-pages";
import { StrategicScopeFilter } from "../dashboard/_components/StrategicScopeFilter";
import { openStrategicInvoice } from "../dashboard/strategic-actions";
import { buildReturnTo } from "@/lib/strategic-return";
import { getConfirmedReportCashControl } from "@/lib/sales-reports";
import {
  computeCalendarKpis,
  obligationsByCity,
  obligationsByClub,
  dayStart,
  addDays,
  endOfWeek,
  monthKeyOf,
  monthBounds,
} from "@/lib/payments";
import {
  loadPaymentObligationsForScope,
  paymentObligationCategoryLabel,
  paymentSourceLabel,
  paymentEntityLabel,
  sumObligationsByEntity,
  type PaymentObligation,
} from "@/lib/payment-obligations";
import { buildEntityCashGaps, type EntityCashGap } from "@/lib/balance";
import { getLatestBalancesForScope } from "@/lib/balance-snapshots";

export const dynamic = "force-dynamic";

const monthFmt = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });
const dayLongFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

type SP = { month?: string; day?: string; entity?: string; scopeMode?: string; companyId?: string; city?: string; clubId?: string };
type EntityFilter = "all" | "ooo" | "ip";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function parseDay(v: string | undefined): Date | null {
  const m = v?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** Monday-first 6×7 grid of day cells covering the selected month. */
function buildMonthGrid(monthStart: Date): { date: Date; inMonth: boolean }[][] {
  const firstIdx = (monthStart.getDay() + 6) % 7; // Monday-first index of the 1st
  let cur = addDays(monthStart, -firstIdx);
  const weeks: { date: Date; inMonth: boolean }[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: { date: Date; inMonth: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      row.push({ date: cur, inMonth: cur.getMonth() === monthStart.getMonth() });
      cur = addDays(cur, 1);
    }
    weeks.push(row);
  }
  // Drop a fully-trailing next-month week (keeps the grid compact).
  return weeks.filter((row) => row.some((c) => c.inMonth));
}

function relativeDueLabel(due: Date, today: Date): { text: string; tone: Tone } {
  const diff = Math.round((dayStart(due).getTime() - today.getTime()) / 86_400_000);
  if (diff < 0) return { text: `просрочено ${-diff} дн.`, tone: "bad" };
  if (diff === 0) return { text: "сегодня", tone: "warn" };
  if (diff === 1) return { text: "завтра", tone: "warn" };
  return { text: `через ${diff} дн.`, tone: "neutral" };
}

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePageAccess("payments");
  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Календарь платежей" description="Предстоящие и просроченные платежи сети" />;
  }
  const companyId = scope.company.id;
  const sp = await searchParams;

  const now = new Date();
  const today = dayStart(now);

  // Part 2 — selected month (default: current).
  const monthKey = sp.month && monthBounds(sp.month) ? sp.month : monthKeyOf(now);
  const bounds = monthBounds(monthKey)!;
  const monthStart = bounds.start;
  const monthLastDay = addDays(bounds.end, -1);
  const monthLabel = cap(monthFmt.format(monthStart));
  const prevMonth = monthKeyOf(new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1));
  const nextMonth = monthKeyOf(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1));

  // Load enough to cover overdue + the selected month + the 7/30-day KPI windows.
  const loadEnd = new Date(Math.max(bounds.end.getTime(), addDays(today, 30).getTime(), endOfWeek(now).getTime()));

  // Mandatory recurring payments are expanded from one month before the earlier
  // of the selected / current month, so recent overdue is covered too.
  const curMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const earlierMonth = monthStart.getTime() < curMonthStart.getTime() ? monthStart : curMonthStart;
  const mandatoryWindowStart = new Date(earlierMonth.getFullYear(), earlierMonth.getMonth() - 1, 1);

  // Strategic owner/GD: obligations may span several accessible Companies. The
  // calendar/day totals AGGREGATE due amounts (allowed — they are payments due),
  // but balances + cash-gap stay per-Company and are only shown when exactly one
  // Company is selected (a merged "available cash" across Companies is forbidden).
  const ctx = await getCurrentAccessContext();
  const strategic = ctx ? isStrategicRole(ctx.effectiveRoles) : false;
  const groups = strategic && ctx ? await resolveStrategicGroups(ctx, sp) : null;
  // One Company for the cash-gap section (single selected, or the only one).
  const financialOne = !groups || groups.filteredCompanyIds.length === 1;
  const finCompanyId = groups ? groups.filteredCompanyIds[0] ?? null : companyId;
  const finClubIds = groups ? groups.byCompany.find((g) => g.companyId === finCompanyId)?.clubIds ?? [] : scope.clubIds;
  const companyNameById = groups?.companyNameById ?? new Map<string, string>();
  const strategicNav = Boolean(groups);
  const returnQuery = groups ? buildReturnTo("payments", sp as Record<string, string | undefined>) : "";

  let obligations: PaymentObligation[];
  if (groups) {
    const per = await Promise.all(
      groups.byCompany.map((g) =>
        loadPaymentObligationsForScope({ companyId: g.companyId, clubIds: g.clubIds, loadEnd, monthKey, windowStart: mandatoryWindowStart }).then((r) => r.obligations),
      ),
    );
    obligations = per.flat();
  } else {
    obligations = (await loadPaymentObligationsForScope({ companyId, clubIds: scope.clubIds, loadEnd, monthKey, windowStart: mandatoryWindowStart })).obligations;
  }
  const [cashRows, balances] = await Promise.all([
    getConfirmedReportCashControl(scope),
    financialOne && finCompanyId
      ? getLatestBalancesForScope(finCompanyId, finClubIds)
      : Promise.resolve({ ooo: { kopeks: null, latestDate: null }, ip: { kopeks: null, latestDate: null }, totalKopeks: null }),
  ]);

  // Part 3 — legal-entity filter (Все / ООО / ИП) for the calendar display.
  const entityFilter: EntityFilter = sp.entity === "ooo" || sp.entity === "ip" ? sp.entity : "all";
  const displayObligations = entityFilter === "all" ? obligations : obligations.filter((o) => o.legalEntityType === entityFilter);

  // Part 1 — KPI windows (follow the filter; dueDate-based obligation set).
  const kpis = computeCalendarKpis(displayObligations, now, monthLastDay);

  // Part 4 — cash source priority: latest BalanceSnapshot → legacy confirmed
  // report cash → null (insufficient). Never invents a balance.
  const cmStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const cmEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const cashRowsThisMonth = cashRows.filter((r) => r.reportDate >= cmStart && r.reportDate < cmEnd);
  // Legacy fallback only applies to the single-Company cash view (cashRows are
  // the cookie company's). In a multi-Company view balances stay hidden.
  const legacyCashOooKopeks = financialOne && cashRowsThisMonth.length > 0
    ? cashRowsThisMonth.reduce((s, r) => s + (r.cashOooKopeks - r.encashmentKopeks), 0)
    : null;
  const oooBalanceKopeks = financialOne ? balances.ooo.kopeks ?? legacyCashOooKopeks : null;
  const ipBalanceKopeks = financialOne ? balances.ip.kopeks : null;
  const totalAvailableKopeks = financialOne ? balances.totalKopeks ?? legacyCashOooKopeks : null;

  // Part 3 — day → obligations map for the selected month (filtered).
  const byDay = new Map<number, PaymentObligation[]>();
  for (const i of displayObligations) {
    if (!i.dueDate) continue;
    const d = dayStart(i.dueDate);
    if (d < monthStart || d >= bounds.end) continue;
    const key = d.getTime();
    const list = byDay.get(key);
    if (list) list.push(i);
    else byDay.set(key, [i]);
  }
  const grid = buildMonthGrid(monthStart);

  // Part 4 — selected day (default to today when viewing the current month).
  const selectedDay = parseDay(sp.day) ?? (monthKey === monthKeyOf(now) ? today : null);
  const selectedDayRows = selectedDay ? (byDay.get(selectedDay.getTime()) ?? []) : [];
  const selectedDayTotal = selectedDayRows.reduce((s, r) => s + r.amountKopeks, 0);

  // Part 5 — upcoming (nearest first, overdue surfaced), max 5 (filtered).
  const upcoming = displayObligations
    .filter((i) => i.dueDate)
    .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())
    .slice(0, 5);

  // Part 8 — city / club aggregation (filtered).
  const cityRows = obligationsByCity(displayObligations, now);
  const clubRows = obligationsByClub(displayObligations);

  // Part 2/4 — per-entity cash gaps (ООО / ИП computed SEPARATELY, never merged).
  // Only for a single Company — a multi-Company gap would offset Companies.
  const sums = sumObligationsByEntity(obligations, addDays(today, 30));
  const gaps = financialOne
    ? buildEntityCashGaps({
        ooo: { balanceKopeks: oooBalanceKopeks, obligationsKopeks: sums.ooo },
        ip: { balanceKopeks: ipBalanceKopeks, obligationsKopeks: sums.ip },
      })
    : null;
  // Unassigned (no legal entity) obligations due in the 30-day window — shown
  // separately, never folded into ООО/ИП cash gaps.
  const unassignedKopeks = sums.unassigned;

  const dayHref = (d: Date) => `/payments?month=${monthKey}&day=${iso(d)}${entityFilter === "all" ? "" : `&entity=${entityFilter}`}`;
  const entityHref = (e: EntityFilter) => `/payments?month=${monthKey}${e === "all" ? "" : `&entity=${e}`}`;

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <PageHeader title="Календарь платежей" description="Что и когда нужно оплатить" />
        <div className="flex flex-wrap items-center gap-2">
          {/* Company-scoped actions: in a multi-Company strategic view they need
              one Company selected first (a plan/balance belongs to one Company). */}
          {groups && groups.multiCompany ? (
            <span className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              Выберите одну компанию, чтобы добавить обязательный платёж или обновить остаток
            </span>
          ) : (
            <>
              <Link
                href="/mandatory-payments"
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                + Обязательный платёж
              </Link>
              <Link
                href="/balances"
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Обновить остаток
              </Link>
            </>
          )}
          {/* Part 2 — month navigation */}
          <div className={`inline-flex items-center gap-1 p-1 ${CARD}`}>
            <Link href={`/payments?month=${prevMonth}`} aria-label="Предыдущий месяц" className="rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800">‹</Link>
            <span className="min-w-[8.5rem] text-center text-sm font-semibold text-slate-800 dark:text-slate-100">{monthLabel}</span>
            <Link href={`/payments?month=${nextMonth}`} aria-label="Следующий месяц" className="rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800">›</Link>
          </div>
        </div>
      </div>

      {groups && groups.scope.accessibleClubs.length > 0 ? (
        <div className="mb-5">
          <StrategicScopeFilter
            companies={groups.scope.accessibleCompanies}
            clubs={groups.scope.accessibleClubs}
            mode={groups.scope.mode}
            companyId={groups.scope.selectedCompanyId}
            city={groups.scope.selectedCity}
            clubId={groups.scope.selectedClubId}
            month=""
            basePath="/payments"
            extra={{ month: monthKey, ...(entityFilter !== "all" ? { entity: entityFilter } : {}) }}
          />
        </div>
      ) : null}

      {/* Part 1 — KPI cards */}
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Сегодня к оплате" value={formatKopeks(kpis.todayKopeks)} />
        <KpiCard label="На этой неделе" value={formatKopeks(kpis.weekKopeks)} />
        <KpiCard label="До конца месяца" value={formatKopeks(kpis.monthEndKopeks)} />
        <KpiCard
          label="Просрочено"
          value={formatKopeks(kpis.overdueKopeks)}
          tone={kpis.overdueKopeks > 0 ? "bad" : "neutral"}
          sub={kpis.overdueCount > 0 ? `${kpis.overdueCount} счёт(ов)` : "нет"}
        />
      </div>

      {/* Current balances (ООО / ИП kept separate; Всего is display-only). In a
          multi-Company view balances are NOT merged — pick one Company. */}
      {financialOne ? (
        <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-3">
          <KpiCard
            label="Остаток ООО"
            value={oooBalanceKopeks === null ? "нет данных" : formatKopeks(oooBalanceKopeks)}
            tone={oooBalanceKopeks !== null && oooBalanceKopeks < 0 ? "bad" : "neutral"}
          />
          <KpiCard label="Остаток ИП" value={ipBalanceKopeks === null ? "нет данных" : formatKopeks(ipBalanceKopeks)} />
          <KpiCard
            label="Всего доступно"
            value={totalAvailableKopeks === null ? "нет данных" : formatKopeks(totalAvailableKopeks)}
            sub="ООО + ИП (справочно)"
            tone={totalAvailableKopeks !== null && totalAvailableKopeks < 0 ? "bad" : "neutral"}
          />
        </div>
      ) : (
        <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Выберите одну компанию, чтобы увидеть остатки и кассовые разрывы по ООО/ИП. Остатки разных сетей не суммируются.
        </div>
      )}

      {/* Part 3 — legal-entity filter */}
      <div className="mb-5 inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 text-sm dark:border-slate-800 dark:bg-slate-900">
        {([["all", "Все"], ["ooo", "ООО"], ["ip", "ИП"]] as const).map(([key, label]) => (
          <Link
            key={key}
            href={entityHref(key)}
            className={`rounded-md px-3 py-1.5 font-medium transition ${entityFilter === key ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"}`}
          >
            {label}
          </Link>
        ))}
      </div>

      {/* Calendar + right rail */}
      <div className="mb-5 grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* Part 3 — visual month calendar */}
        <div className={`min-w-0 overflow-hidden xl:col-span-2 ${CARD}`}>
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{monthLabel}</span>
            <Legend />
          </div>
          <div className="p-3">
            <div className="grid grid-cols-7 gap-1.5">
              {WEEKDAYS.map((w) => (
                <div key={w} className="pb-1 text-center text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">{w}</div>
              ))}
              {grid.flat().map((cell) => {
                const rows = cell.inMonth ? byDay.get(cell.date.getTime()) ?? [] : [];
                const total = rows.reduce((s, r) => s + r.amountKopeks, 0);
                const isToday = cell.date.getTime() === today.getTime();
                const isSelected = selectedDay !== null && cell.date.getTime() === selectedDay.getTime();
                const overdue = cell.inMonth && rows.length > 0 && cell.date < today;
                return (
                  <DayCell
                    key={cell.date.getTime()}
                    href={dayHref(cell.date)}
                    day={cell.date.getDate()}
                    inMonth={cell.inMonth}
                    total={total}
                    count={rows.length}
                    overdue={overdue}
                    isToday={isToday}
                    isSelected={isSelected}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Right rail: selected day + per-entity cash gaps (ООО / ИП separately) */}
        <div className="flex min-w-0 flex-col gap-4">
          <SelectedDayCard date={selectedDay} rows={selectedDayRows} total={selectedDayTotal} companyNameById={companyNameById} strategicNav={strategicNav} returnQuery={returnQuery} />
          {gaps ? (
            <>
              <EntityGapCard gap={gaps.ooo} />
              <EntityGapCard gap={gaps.ip} />
              {unassignedKopeks > 0 ? (
                <div className={`p-4 ${CARD}`}>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Не распределено (без юрлица), 30 дн.</div>
                  <div className="mt-1 text-base font-semibold text-slate-700 dark:text-slate-200">{formatKopeks(unassignedKopeks)}</div>
                </div>
              ) : null}
            </>
          ) : (
            <div className={`p-4 text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
              Кассовые разрывы по ООО/ИП доступны при выборе одной компании.
            </div>
          )}
        </div>
      </div>

      {/* Part 5 + Part 8 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <UpcomingCard rows={upcoming} today={today} strategicNav={strategicNav} returnQuery={returnQuery} />
        <CitySummaryCard rows={cityRows} />
        <ClubSummaryCard rows={clubRows} />
      </div>
    </div>
  );
}

// --- design tokens ---------------------------------------------------------

type Tone = "good" | "warn" | "bad" | "neutral";

function Legend() {
  const item = (cls: string, label: string) => (
    <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500">
      <span className={`h-2 w-2 rounded-full ${cls}`} />
      {label}
    </span>
  );
  return (
    <div className="hidden items-center gap-3 sm:flex">
      {item("bg-amber-500", "к оплате")}
      {item("bg-rose-500", "просрочено")}
      {item("ring-2 ring-brand-500 ring-inset", "сегодня")}
    </div>
  );
}

function KpiCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: Tone }) {
  const valueCls = tone === "bad" ? "text-rose-600 dark:text-rose-400" : "text-slate-900 dark:text-slate-100";
  return (
    <div className={`flex h-full flex-col p-5 ${CARD}`}>
      <div className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-2 truncate text-2xl font-semibold tracking-tight ${valueCls}`}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">{sub}</div> : null}
    </div>
  );
}

function DayCell({
  href,
  day,
  inMonth,
  total,
  count,
  overdue,
  isToday,
  isSelected,
}: {
  href: string;
  day: number;
  inMonth: boolean;
  total: number;
  count: number;
  overdue: boolean;
  isToday: boolean;
  isSelected: boolean;
}) {
  if (!inMonth) {
    return <div className="min-h-[64px] rounded-lg bg-slate-50/40 dark:bg-slate-800/20" aria-hidden />;
  }
  // Indicator size by daily total (Part 3).
  const big = total > 100_000 * 100;
  const mid = !big && total > 20_000 * 100;
  const dotSize = big ? "h-2.5 w-2.5" : mid ? "h-2 w-2" : "h-1.5 w-1.5";
  const dotColor = count === 0 ? "" : overdue ? "bg-rose-500" : "bg-amber-500";
  const base = "flex min-h-[64px] flex-col rounded-lg border p-1.5 transition";
  const stateBg =
    count === 0
      ? "border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800/40"
      : overdue
        ? "border-rose-200 bg-rose-50/60 hover:bg-rose-50 dark:border-rose-500/20 dark:bg-rose-500/5"
        : "border-amber-200 bg-amber-50/60 hover:bg-amber-50 dark:border-amber-500/20 dark:bg-amber-500/5";
  const ring = isSelected ? "ring-2 ring-brand-500 ring-inset" : isToday ? "ring-2 ring-brand-400/70 ring-inset" : "";
  return (
    <Link href={href} className={`${base} ${stateBg} ${ring}`}>
      <div className="flex items-center justify-between">
        <span className={`text-xs font-semibold ${isToday ? "text-brand-600 dark:text-brand-400" : "text-slate-600 dark:text-slate-300"}`}>{day}</span>
        {count > 0 ? <span className={`shrink-0 rounded-full ${dotSize} ${dotColor}`} /> : null}
      </div>
      {count > 0 ? (
        <div className="mt-auto truncate text-[11px] font-medium text-slate-600 dark:text-slate-300">{formatKopeksShort(total)} ₽</div>
      ) : null}
    </Link>
  );
}

function PanelCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col overflow-hidden ${CARD}`}>
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</span>
        {hint ? <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * Row wrapper for a payment obligation. For a strategic (multi-Company) view an
 * Invoice obligation may belong to another Company, so it must open through the
 * safe context-switch action (verify access + record ownership → set scope →
 * allowlisted redirect). Mandatory/payroll obligations have no cross-Company
 * detail target, so they render non-clickable rather than linking into the
 * wrong scope. Non-strategic roles keep the existing in-scope Link.
 */
function ObligationLink({
  obligation: r,
  strategicNav,
  returnQuery,
  className,
  children,
}: {
  obligation: PaymentObligation;
  strategicNav: boolean;
  returnQuery: string;
  className: string;
  children: React.ReactNode;
}) {
  if (strategicNav) {
    if (r.sourceType === "invoice") {
      return (
        <form action={openStrategicInvoice}>
          <input type="hidden" name="companyId" value={r.companyId} />
          <input type="hidden" name="objectId" value={r.sourceId} />
          <input type="hidden" name="returnTo" value={returnQuery} />
          <button type="submit" className={`w-full text-left ${className}`}>{children}</button>
        </form>
      );
    }
    // Mandatory / payroll: no safe cross-Company detail target — not clickable.
    return <div className={className}>{children}</div>;
  }
  return (
    <Link href={r.href ?? `/invoices/${r.sourceId}`} className={className}>
      {children}
    </Link>
  );
}

function SelectedDayCard({ date, rows, total, companyNameById, strategicNav, returnQuery }: { date: Date | null; rows: PaymentObligation[]; total: number; companyNameById: Map<string, string>; strategicNav: boolean; returnQuery: string }) {
  const showCompany = companyNameById.size > 1;
  return (
    <PanelCard title="Платежи дня" hint={date ? dayLongFmt.format(date) : undefined}>
      {!date ? (
        <Empty text="Выберите день в календаре" />
      ) : rows.length === 0 ? (
        <Empty text="Нет платежей на выбранный день" />
      ) : (
        <>
          <div className="flex items-center justify-between px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400">
            <span>{rows.length} платёж(ей)</span>
            <span className="font-semibold text-slate-900 dark:text-slate-100">{formatKopeks(total)}</span>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
            {rows.map((r) => (
              <li key={r.id}>
                <ObligationLink obligation={r} strategicNav={strategicNav} returnQuery={returnQuery} className="flex items-start justify-between gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {paymentObligationCategoryLabel(r)}
                      {r.counterpartyName ? <span className="ml-1 font-normal text-slate-500 dark:text-slate-400">· {r.counterpartyName}</span> : null}
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {showCompany ? `${companyNameById.get(r.companyId) ?? "—"} · ` : ""}{r.clubName} · {r.city}
                      {r.legalEntityName ? ` · ${r.legalEntityName}` : r.legalEntityType === null ? " · Юрлицо не указано" : ""} · {paymentSourceLabel(r.sourceType)}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="whitespace-nowrap text-sm font-semibold text-slate-900 dark:text-slate-100">{formatKopeks(r.amountKopeks)}</span>
                    <EntityBadge type={r.legalEntityType} />
                  </div>
                </ObligationLink>
              </li>
            ))}
          </ul>
        </>
      )}
    </PanelCard>
  );
}

function EntityBadge({ type }: { type: "ooo" | "ip" | null }) {
  const cls = type === "ooo"
    ? "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:ring-sky-500/20"
    : type === "ip"
      ? "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-400 dark:ring-violet-500/20"
      : "bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700";
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${cls}`}>{paymentEntityLabel(type)}</span>;
}

function EntityGapCard({ gap }: { gap: EntityCashGap }) {
  const label = gap.type === "ooo" ? "ООО" : "ИП";
  const riskText = gap.risk === "unknown" ? "Нет данных" : gap.risk === "high" ? "Высокий риск" : "Низкий риск";
  const tone = gap.risk === "unknown"
    ? "bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800/50 dark:text-slate-400 dark:ring-slate-700"
    : gap.risk === "high"
      ? "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:ring-rose-500/20"
      : "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20";
  return (
    <PanelCard title={`Кассовый разрыв · ${label}`}>
      <div className="px-4 py-3">
        <dl className="space-y-2.5 text-sm">
          <Row label="Остаток" value={gap.currentBalanceKopeks === null ? "нет данных" : formatKopeks(gap.currentBalanceKopeks)} muted={gap.currentBalanceKopeks === null} />
          <Row label="Обязательства (30 дн.)" value={formatKopeks(gap.obligationsKopeks)} />
        </dl>
        <div className={`mt-3 flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-semibold ring-1 ring-inset ${tone}`}>
          <span>{gap.projectedBalanceKopeks === null ? "Прогноз" : "Прогноз остатка"}</span>
          <span className="text-right">{gap.projectedBalanceKopeks === null ? riskText : `${formatKopeks(gap.projectedBalanceKopeks)} · ${riskText}`}</span>
        </div>
      </div>
    </PanelCard>
  );
}

function UpcomingCard({ rows, today, strategicNav, returnQuery }: { rows: PaymentObligation[]; today: Date; strategicNav: boolean; returnQuery: string }) {
  return (
    <PanelCard title="Ближайшие платежи">
      {rows.length === 0 ? (
        <Empty text="Нет платежей" />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
          {rows.map((r) => {
            const rel = r.dueDate ? relativeDueLabel(r.dueDate, today) : { text: "нет срока", tone: "neutral" as Tone };
            const relCls =
              rel.tone === "bad" ? "text-rose-600 dark:text-rose-400" : rel.tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-slate-400 dark:text-slate-500";
            return (
              <li key={r.id}>
                <ObligationLink obligation={r} strategicNav={strategicNav} returnQuery={returnQuery} className="flex items-start justify-between gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {paymentObligationCategoryLabel(r)}
                      {r.counterpartyName ? <span className="ml-1 font-normal text-slate-500 dark:text-slate-400">· {r.counterpartyName}</span> : null}
                    </div>
                    <div className={`truncate text-xs ${relCls}`}>{rel.text} · {r.clubName} · {paymentSourceLabel(r.sourceType)}</div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="whitespace-nowrap text-sm font-semibold text-slate-900 dark:text-slate-100">{formatKopeks(r.amountKopeks)}</span>
                    <EntityBadge type={r.legalEntityType} />
                  </div>
                </ObligationLink>
              </li>
            );
          })}
        </ul>
      )}
    </PanelCard>
  );
}

function CitySummaryCard({ rows }: { rows: { city: string; toPayKopeks: number; overdueKopeks: number }[] }) {
  return (
    <PanelCard title="По городам">
      {rows.length === 0 ? (
        <Empty text="Нет данных" />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
          {rows.map((c) => (
            <li key={c.city} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{c.city}</span>
              <span className="flex shrink-0 items-center gap-3 text-sm">
                <span className="text-slate-900 dark:text-slate-100">{formatKopeks(c.toPayKopeks)}</span>
                {c.overdueKopeks > 0 ? (
                  <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 ring-1 ring-inset ring-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:ring-rose-500/20">
                    просрочено {formatKopeks(c.overdueKopeks)}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  );
}

function ClubSummaryCard({ rows }: { rows: { clubId: string; clubName: string; toPayKopeks: number }[] }) {
  return (
    <PanelCard title="По клубам">
      {rows.length === 0 ? (
        <Empty text="Нет данных" />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
          {rows.map((c) => (
            <li key={c.clubId} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{c.clubName}</span>
              <span className="shrink-0 text-sm text-slate-900 dark:text-slate-100">{formatKopeks(c.toPayKopeks)}</span>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  );
}

function Row({ label, value, muted, tone, bold }: { label: string; value: string; muted?: boolean; tone?: Tone; bold?: boolean }) {
  const valueCls = muted
    ? "text-slate-400 dark:text-slate-500"
    : tone === "bad"
      ? "text-rose-600 dark:text-rose-400"
      : "text-slate-900 dark:text-slate-100";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className={`${bold ? "font-semibold" : "font-medium"} ${valueCls}`}>{value}</dd>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">{text}</div>;
}
