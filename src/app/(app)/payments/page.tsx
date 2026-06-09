import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { requirePageAccess, getCurrentCompanyAndClub, getClubsInScope } from "@/lib/access";
import { expenseCategoryLabel, EXPENSE_CATEGORY_OPTIONS } from "@/lib/expenses";
import { INVOICE_STATUS_LABELS } from "@/lib/invoices";
import {
  loadPaymentInvoices,
  computePaymentSummary,
  obligationsByCity,
  obligationsByClub,
  paymentAlerts,
  dayStart,
  addDays,
  monthKeyOf,
  type PaymentInvoice,
} from "@/lib/payments";

export const dynamic = "force-dynamic";

const dayGroupFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

type SP = {
  status?: string; // all | overdue | upcoming | paid
  range?: string; // today | 7 | 30 | custom
  from?: string;
  to?: string;
  city?: string;
  club?: string;
  entity?: string;
  category?: string;
};

const STATUSES = [
  { key: "all", label: "Все" },
  { key: "overdue", label: "Просрочено" },
  { key: "upcoming", label: "Предстоящие" },
  { key: "paid", label: "Оплаченные" },
];
const RANGES = [
  { key: "today", label: "Сегодня" },
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
  { key: "custom", label: "Период" },
];

function parseDay(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
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
  const rangeKey = RANGES.some((r) => r.key === sp.range) ? sp.range! : "30";
  const statusKey = STATUSES.some((s) => s.key === sp.status) ? sp.status! : "all";

  // Calendar window end (for grouping/aggregation).
  let rangeEnd: Date;
  if (rangeKey === "today") rangeEnd = addDays(today, 1);
  else if (rangeKey === "7") rangeEnd = addDays(today, 7);
  else if (rangeKey === "custom") rangeEnd = parseDay(sp.to) ?? addDays(today, 30);
  else rangeEnd = addDays(today, 30);
  const rangeStart = rangeKey === "custom" ? parseDay(sp.from) ?? today : today;
  // Always load enough for the summary cards (overdue + 30-day windows).
  const loadEnd = new Date(Math.max(rangeEnd.getTime(), addDays(today, 30).getTime()));

  const [clubs, entities, { obligations: allObligations, paid: allPaid }] = await Promise.all([
    getClubsInScope(scope),
    prisma.legalEntity.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    loadPaymentInvoices(companyId, scope.clubIds, loadEnd, monthKeyOf(now)),
  ]);

  // --- Part 5 filters (non-date), applied to both sets ---
  const cities = [...new Set(clubs.map((c) => c.city))].sort((a, b) => a.localeCompare(b));
  const entityNameById = new Map(entities.map((e) => [e.id, e.name]));
  const wantCity = sp.city && cities.includes(sp.city) ? sp.city : null;
  const wantClub = sp.club && scope.clubIds.includes(sp.club) ? sp.club : null;
  const wantEntity = sp.entity && entityNameById.has(sp.entity) ? entityNameById.get(sp.entity)! : null;
  const wantCategory = sp.category && EXPENSE_CATEGORY_OPTIONS.some((c) => c.key === sp.category) ? sp.category! : null;

  const matchFilters = (i: PaymentInvoice): boolean =>
    (!wantCity || i.city === wantCity) &&
    (!wantClub || i.clubId === wantClub) &&
    (!wantEntity || i.legalEntityName === wantEntity) &&
    (!wantCategory || i.expenseCategory === wantCategory);

  const obligations = allObligations.filter(matchFilters);
  const paid = allPaid.filter(matchFilters);

  // --- Part 2/3 summary (fixed windows, from filtered set) ---
  const summary = computePaymentSummary(obligations, paid, now);

  // --- Part 4 calendar: which rows to show by status filter + date range ---
  const inRange = (d: Date) => d >= rangeStart && d < addDays(rangeEnd, 1);
  let calendarRows: PaymentInvoice[];
  let groupByPaid = false;
  if (statusKey === "paid") {
    calendarRows = paid;
    groupByPaid = true;
  } else if (statusKey === "overdue") {
    calendarRows = obligations.filter((i) => i.dueDate && i.dueDate < today);
  } else if (statusKey === "upcoming") {
    calendarRows = obligations.filter((i) => i.dueDate && i.dueDate >= today && inRange(i.dueDate));
  } else {
    calendarRows = obligations.filter((i) => i.dueDate && (i.dueDate < today || inRange(i.dueDate)));
  }

  // Group by day (dueDate, or paidAt for the paid view).
  const groups = new Map<number, { date: Date; rows: PaymentInvoice[] }>();
  for (const r of calendarRows) {
    const d = groupByPaid ? r.paidAt : r.dueDate;
    if (!d) continue;
    const key = dayStart(d).getTime();
    const g = groups.get(key) ?? { date: dayStart(d), rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => (groupByPaid ? b.date.getTime() - a.date.getTime() : a.date.getTime() - b.date.getTime()));

  // --- Parts 6/7/8 aggregations + alerts (from filtered obligations) ---
  const cityRows = obligationsByCity(obligations, now);
  const clubRows = obligationsByClub(obligations);
  const alerts = paymentAlerts(obligations, now);

  // Helper to preserve filters in links.
  const qs = (over: Partial<SP>) => {
    const merged: SP = { status: statusKey, range: rangeKey, from: sp.from, to: sp.to, city: wantCity ?? undefined, club: wantClub ?? undefined, entity: sp.entity, category: wantCategory ?? undefined, ...over };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
    return `/payments?${p.toString()}`;
  };

  return (
    <div>
      <PageHeader title="Календарь платежей" description="Предстоящие обязательства, просрочка и оплаты сети" />

      {/* Part 2: executive summary */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <SummaryCard label="Просрочено" value={formatKopeks(summary.overdueKopeks)} accent={summary.overdueKopeks > 0 ? "text-rose-700" : "text-slate-900"} sub={summary.overdueCount > 0 ? `${summary.overdueCount} счёт(ов)` : "нет"} />
        <SummaryCard label="Сегодня" value={formatKopeks(summary.todayKopeks)} />
        <SummaryCard label="7 дней" value={formatKopeks(summary.within7Kopeks)} />
        <SummaryCard label="30 дней" value={formatKopeks(summary.within30Kopeks)} />
        <SummaryCard label="Оплачено за месяц" value={formatKopeks(summary.paidThisMonthKopeks)} accent="text-emerald-700" />
      </div>

      {/* Part 8: alerts */}
      {alerts.length > 0 ? (
        <div className="mb-6 space-y-2">
          {alerts.map((a, i) => (
            <div
              key={i}
              className={`rounded-md px-3 py-2 text-sm ring-1 ring-inset ${
                a.tone === "red" ? "bg-rose-50 text-rose-700 ring-rose-200" : a.tone === "yellow" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"
              }`}
            >
              {a.text}
            </div>
          ))}
        </div>
      ) : null}

      {/* Part 5: filters */}
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <Select name="status" label="Статус" value={statusKey} options={STATUSES.map((s) => ({ value: s.key, label: s.label }))} />
        <Select name="range" label="Период" value={rangeKey} options={RANGES.map((r) => ({ value: r.key, label: r.label }))} />
        <DateField name="from" label="С даты" value={sp.from} />
        <DateField name="to" label="По дату" value={sp.to} />
        <Select name="city" label="Город" value={wantCity ?? ""} options={[{ value: "", label: "Все" }, ...cities.map((c) => ({ value: c, label: c }))]} />
        <Select name="club" label="Клуб" value={wantClub ?? ""} options={[{ value: "", label: "Все" }, ...clubs.map((c) => ({ value: c.id, label: c.name }))]} />
        <Select name="entity" label="Юрлицо" value={sp.entity ?? ""} options={[{ value: "", label: "Все" }, ...entities.map((e) => ({ value: e.id, label: e.name }))]} />
        <Select name="category" label="Статья" value={wantCategory ?? ""} options={[{ value: "", label: "Все" }, ...EXPENSE_CATEGORY_OPTIONS.map((c) => ({ value: c.key, label: c.label }))]} />
        <button type="submit" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700">Показать</button>
      </form>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Part 4: calendar list */}
        <div className="xl:col-span-2 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
            {groupByPaid ? "Оплаченные платежи" : "График платежей"}
          </div>
          {orderedGroups.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">Платежей по выбранным условиям нет.</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {orderedGroups.map((g) => {
                const groupTotal = g.rows.reduce((s, r) => s + r.amountKopeks, 0);
                const overdueDay = !groupByPaid && g.date < today;
                return (
                  <div key={g.date.getTime()} className="px-4 py-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className={`text-sm font-semibold ${overdueDay ? "text-rose-700" : "text-slate-700"}`}>
                        {dayGroupFmt.format(g.date)}
                        {overdueDay ? " · просрочено" : ""}
                      </span>
                      <span className="text-sm font-medium text-slate-900">{formatKopeks(groupTotal)}</span>
                    </div>
                    <ul className="space-y-1">
                      {g.rows.map((r) => (
                        <li key={r.id}>
                          <Link href={`/invoices/${r.id}`} className="flex items-start justify-between gap-3 rounded-md px-2 py-1.5 transition hover:bg-slate-50">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-slate-900">
                                {expenseCategoryLabel(r.expenseCategory)}
                                {r.counterpartyName ? <span className="ml-1 text-slate-500">· {r.counterpartyName}</span> : null}
                              </div>
                              <div className="truncate text-xs text-slate-500">
                                {r.clubName} · {r.city}
                                {r.legalEntityName ? ` · ${r.legalEntityName}` : ""}
                                {groupByPaid ? "" : ` · ${INVOICE_STATUS_LABELS[r.status] ?? r.status}`}
                              </div>
                            </div>
                            <span className="whitespace-nowrap text-sm font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-6">
          {/* Part 6: city aggregation */}
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">Обязательства по городам</div>
            {cityRows.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-slate-500">Нет данных.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {cityRows.map((c) => (
                  <li key={c.city} className="px-4 py-3">
                    <Link href={qs({ city: c.city })} className="block">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-900">{c.city}</span>
                        <span className="text-sm font-medium text-slate-900">{formatKopeks(c.toPayKopeks)}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        К оплате: {formatKopeks(c.toPayKopeks)} · Просрочено: <span className={c.overdueKopeks > 0 ? "text-rose-600" : ""}>{formatKopeks(c.overdueKopeks)}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Part 7: club aggregation */}
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">Обязательства по клубам</div>
            {clubRows.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-slate-500">Нет данных.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {clubRows.map((c) => (
                  <li key={c.clubId} className="px-4 py-3">
                    <Link href={qs({ club: c.clubId })} className="flex items-center justify-between hover:text-brand-700">
                      <span className="text-sm font-medium text-slate-900">{c.clubName}</span>
                      <span className="text-sm font-medium text-slate-900">{formatKopeks(c.toPayKopeks)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 truncate text-xl font-semibold ${accent ?? "text-slate-900"}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

function Select({ name, label, value, options }: { name: string; label: string; value: string; options: { value: string; label: string }[] }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      <select name={name} defaultValue={value} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500">
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function DateField({ name, label, value }: { name: string; label: string; value?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      <input type="date" name={name} defaultValue={value ?? ""} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
    </label>
  );
}
