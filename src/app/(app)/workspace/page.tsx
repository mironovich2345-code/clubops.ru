import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import { requirePageAccess, getCurrentCompanyAndClub, getClubsInScope, getCurrentAccessContext } from "@/lib/access";
import { canCloseMonth } from "@/lib/auth";
import { getExpensesForScope, expenseCategoryLabel } from "@/lib/expenses";
import { getRefundsForScope } from "@/lib/refunds";
import { getPendingSalesReports } from "@/lib/sales-reports";
import { APPROVAL_STATUS_LABELS } from "@/lib/approval";
import { dayStart, addDays, monthKeyOf } from "@/lib/payments";
import { loadPaymentObligationsForScope, paymentObligationCategoryLabel, type PaymentObligation } from "@/lib/payment-obligations";
import { getMonthCloseInfo, isValidMonth } from "@/lib/month-close";
import { getActiveReopenRequest, getLatestReopenRequestView } from "@/lib/month-reopen";
import { WorkspaceMonthControls } from "./_components/WorkspaceMonthControls";

export const dynamic = "force-dynamic";

const monthFmt = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Refund / invoice statuses that still need work (not finished or dropped).
const FINAL_STATUSES = new Set(["paid", "rejected", "canceled"]);
const EXPENSE_REVIEW_STATUS = "waiting_budget_approval";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dueFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams?: Promise<{ closeMonth?: string }>;
}) {
  const user = await requirePageAccess("workspace");
  const [scope, ctx, params] = await Promise.all([
    getCurrentCompanyAndClub(user),
    getCurrentAccessContext(),
    searchParams ? searchParams : Promise.resolve({} as { closeMonth?: string }),
  ]);
  if (!scope.company) {
    return <NoCompanyState title="Рабочий стол" description="Задачи бухгалтера" />;
  }
  const companyId = scope.company.id;
  const now = new Date();
  const today = dayStart(now);

  // Month management (Chief Accountant only — ordinary accountant never sees it).
  const canManageMonth = ctx ? canCloseMonth(ctx.effectiveRoles) : false;
  const prevMonthKey = monthKeyOf(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const rawMonth = (params?.closeMonth ?? "").trim();
  const manageMonth = isValidMonth(rawMonth) ? rawMonth : prevMonthKey;
  const [monthInfo, latestReopen, activeReopen] = canManageMonth
    ? await Promise.all([
        getMonthCloseInfo(companyId, null, manageMonth),
        getLatestReopenRequestView(companyId, null, manageMonth),
        getActiveReopenRequest(companyId, null, manageMonth),
      ])
    : [null, null, null];
  const manageMonthLabel = capitalize(monthFmt.format(new Date(`${manageMonth}-01T00:00:00`)));

  // All data is the existing scoped source of truth (companyId + allowedClubIds).
  const [clubs, expenses, refunds, pendingReports, { obligations }] = await Promise.all([
    getClubsInScope(scope),
    getExpensesForScope(scope),
    getRefundsForScope(scope),
    getPendingSalesReports(scope),
    loadPaymentObligationsForScope({
      companyId,
      clubIds: scope.clubIds,
      loadEnd: addDays(today, 60),
      monthKey: monthKeyOf(now),
      windowStart: new Date(now.getFullYear(), now.getMonth() - 1, 1),
    }),
  ]);

  const expensesPending = expenses.filter((e) => e.status === EXPENSE_REVIEW_STATUS);
  const refundsPending = refunds.filter((r) => !FINAL_STATUSES.has(r.status));

  // Per-club rollup (Part 4.1). Sales reports expose clubName only, so match by
  // name within the already-scoped set.
  const clubCards = clubs.map((c) => ({
    id: c.id,
    name: c.name,
    city: c.city,
    salesToCheck: pendingReports.filter((r) => r.clubName === c.name).length,
    upcomingPayments: obligations.filter((o) => o.clubId === c.id).length,
    upcomingPaymentsKopeks: obligations.filter((o) => o.clubId === c.id).reduce((s, o) => s + o.amountKopeks, 0),
    refunds: refundsPending.filter((r) => r.clubId === c.id).length,
    expenses: expensesPending.filter((e) => e.clubId === c.id).length,
  }));

  // My tasks (Part 4.2).
  const tasks = [
    { label: "Счета к оплате", count: obligations.length, href: "/invoices" },
    { label: "Возвраты", count: refundsPending.length, href: "/refunds" },
    { label: "Расходы на проверке", count: expensesPending.length, href: "/expenses" },
    { label: "Продажи на проверке", count: pendingReports.length, href: "/sales" },
  ];

  // Nearest payments (Part 4.3) — reuse the payment calendar obligations.
  const upcoming = [...obligations]
    .filter((o) => o.dueDate)
    .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())
    .slice(0, 5);

  const recentRefunds = refundsPending.slice(0, 5);
  const recentExpenses = expensesPending.slice(0, 5);

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Рабочий стол" description="Задачи бухгалтера" />

      {canManageMonth && monthInfo ? (
        <WorkspaceMonthControls
          month={manageMonth}
          monthLabel={manageMonthLabel}
          status={monthInfo.status}
          closedByName={monthInfo.closedByName}
          closedAt={monthInfo.closedAt ? monthInfo.closedAt.toISOString() : null}
          latest={
            latestReopen
              ? { status: latestReopen.status, reason: latestReopen.reason, reviewComment: latestReopen.reviewComment }
              : null
          }
          activeRequestId={activeReopen?.id ?? null}
        />
      ) : null}

      {/* Part 4.2 — my tasks */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tasks.map((t) => (
          <Link key={t.label} href={t.href} className={`flex h-full flex-col p-5 transition hover:border-brand-300 hover:shadow-md dark:hover:border-brand-700 ${CARD}`}>
            <div className="text-sm font-medium text-slate-500 dark:text-slate-400">{t.label}</div>
            <div className={`mt-2 text-3xl font-semibold tracking-tight ${t.count > 0 ? "text-slate-900 dark:text-slate-100" : "text-slate-300 dark:text-slate-600"}`}>{t.count}</div>
          </Link>
        ))}
      </div>

      {/* Part 4.1 — club cards */}
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Клубы</h2>
      {clubCards.length === 0 ? (
        <div className={`mb-6 px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>Нет доступных клубов</div>
      ) : (
        <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {clubCards.map((c) => (
            <div key={c.id} className={`p-5 ${CARD}`}>
              <div className="mb-4">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">{c.city || "—"}</div>
                <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">{c.name}</div>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <ClubMetric label="Проверить продажи" value={c.salesToCheck} />
                <ClubMetric label="Ближайшие оплаты" value={c.upcomingPayments} hint={c.upcomingPaymentsKopeks > 0 ? formatKopeks(c.upcomingPaymentsKopeks) : undefined} />
                <ClubMetric label="Возвраты" value={c.refunds} />
                <ClubMetric label="Наличные расходы" value={c.expenses} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Lower grid: nearest payments / refunds / cash expenses */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Part 4.3 — nearest payments */}
        <PanelCard title="Ближайшие оплаты" href="/payments" hint="календарь платежей">
          {upcoming.length === 0 ? (
            <Empty text="Нет ближайших оплат" />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {upcoming.map((o) => (
                <ListRow
                  key={o.id}
                  href={`/invoices/${o.id}`}
                  title={paymentTitle(o)}
                  subtitle={`${o.clubName}${o.dueDate ? ` · до ${dueFmt.format(o.dueDate)}` : ""}`}
                  amount={formatKopeks(o.amountKopeks)}
                  overdue={Boolean(o.dueDate && dayStart(o.dueDate) < today)}
                />
              ))}
            </ul>
          )}
        </PanelCard>

        {/* Part 4.4 — refunds */}
        <PanelCard title="Возвраты" href="/refunds" hint={`${refundsPending.length} в работе`}>
          {recentRefunds.length === 0 ? (
            <Empty text="Нет возвратов в работе" />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {recentRefunds.map((r) => (
                <ListRow
                  key={r.id}
                  href={`/refunds/${r.id}`}
                  title={r.clientName ?? "Возврат клиенту"}
                  subtitle={`${r.club.name} · ${APPROVAL_STATUS_LABELS[r.status] ?? r.status}`}
                  amount={formatKopeks(r.amountKopeks)}
                />
              ))}
            </ul>
          )}
        </PanelCard>

        {/* Part 4.5 — cash expenses under review */}
        <PanelCard title="Наличные расходы" href="/expenses" hint={`${expensesPending.length} на проверке`}>
          {recentExpenses.length === 0 ? (
            <Empty text="Нет расходов на проверке" />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {recentExpenses.map((e) => (
                <ListRow
                  key={e.id}
                  href={`/expenses/${e.id}`}
                  title={e.vendorName ?? e.recipientName ?? expenseCategoryLabel(e.category)}
                  subtitle={`${e.club.name} · ${expenseCategoryLabel(e.category)}`}
                  amount={formatKopeks(e.amountKopeks)}
                />
              ))}
            </ul>
          )}
        </PanelCard>
      </div>
    </div>
  );
}

function paymentTitle(o: PaymentObligation): string {
  const cat = paymentObligationCategoryLabel(o);
  return o.counterpartyName ? `${cat} · ${o.counterpartyName}` : cat;
}

function ClubMetric({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] text-slate-400 dark:text-slate-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${value > 0 ? "text-slate-900 dark:text-slate-100" : "text-slate-300 dark:text-slate-600"}`}>{value}</div>
      {hint ? <div className="truncate text-[11px] text-slate-400 dark:text-slate-500">{hint}</div> : null}
    </div>
  );
}

function PanelCard({ title, href, hint, children }: { title: string; href: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col overflow-hidden ${CARD}`}>
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <Link href={href} className="text-sm font-semibold text-slate-700 hover:text-brand-700 dark:text-slate-200 dark:hover:text-brand-400">{title}</Link>
        {hint ? <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function ListRow({ href, title, subtitle, amount, overdue }: { href: string; title: string; subtitle: string; amount: string; overdue?: boolean }) {
  return (
    <li>
      <Link href={href} className="flex items-start justify-between gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/40">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{title}</div>
          <div className={`truncate text-xs ${overdue ? "text-rose-600 dark:text-rose-400" : "text-slate-500 dark:text-slate-400"}`}>{subtitle}{overdue ? " · просрочено" : ""}</div>
        </div>
        <span className="whitespace-nowrap text-sm font-semibold text-slate-900 dark:text-slate-100">{amount}</span>
      </Link>
    </li>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">{text}</div>;
}
