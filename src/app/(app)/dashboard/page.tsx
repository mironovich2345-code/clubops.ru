import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/access";
import { formatKopeks } from "@/lib/money";
import { getInvoicesForScope } from "@/lib/invoices";
import { getExpensesForScope, summarizeExpenses, expenseCategoryLabel } from "@/lib/expenses";
import { getSalesForScope, summarizeSales } from "@/lib/sales";
import { getRefundsForScope } from "@/lib/refunds";
import {
  getBudgetsForScope,
  computeBudgetOverruns,
  getPendingBudgetRequestsForScope,
  budgetCategoryLabel,
} from "@/lib/budgets";
import { getCurrentCompanyAndClub, getClubsInScope, getCurrentAccessContext } from "@/lib/access";
import { canManageSalesPlans, type Role } from "@/lib/auth";
import { getSalesPlan, getSalesPlansForCompanyMonth, salesPlanProgress, monthKey } from "@/lib/sales-plans";
import { NoCompanyState } from "@/components/NoCompanyState";
import { SalesPlanForm } from "./_components/SalesPlanForm";
import { profitSummary, clubRanking, type ClubRankRow } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" });
const monthFormatter = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });

const FINANCIAL_ROLES = new Set<Role>(["owner", "general_director", "regional_director", "manager", "accountant"]);
/** A pure marketer sees sales/plan/stats only; anyone else sees financials. */
function canSeeFinancials(roles: readonly Role[]): boolean {
  return roles.some((r) => FINANCIAL_ROLES.has(r));
}

function planTone(pct: number | null): string {
  if (pct === null) return "text-slate-900";
  if (pct >= 100) return "text-emerald-700";
  if (pct >= 80) return "text-amber-700";
  return "text-rose-700";
}

export default async function DashboardPage() {
  const user = await requirePageAccess("dashboard");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Дашборд" description="Состояние бизнеса" />;
  }

  const now = new Date();
  const planMonth = monthKey(now);

  const [clubs, invoices, expenses, sales, refunds, ctx, salesPlan, planRows, budgets, budgetRequests] =
    await Promise.all([
      getClubsInScope(scope),
      getInvoicesForScope(scope),
      getExpensesForScope(scope),
      getSalesForScope(scope),
      getRefundsForScope(scope),
      getCurrentAccessContext(),
      getSalesPlan(scope.company.id, scope.club?.id ?? null, planMonth),
      getSalesPlansForCompanyMonth(scope.company.id, planMonth),
      getBudgetsForScope(scope, planMonth),
      getPendingBudgetRequestsForScope(scope),
    ]);

  const roles = ctx?.effectiveRoles ?? [];
  const financials = canSeeFinancials(roles);
  const canEditPlan = canManageSalesPlans(roles);
  const planScopeLabel = scope.club ? scope.club.name : "вся компания";

  // Realized expenses = confirmed expenses + paid invoices + paid refunds.
  const expenseEvents = [
    ...expenses.filter((e) => e.status === "confirmed").map((e) => ({ clubId: e.clubId, category: e.category, amountKopeks: e.amountKopeks, expenseDate: e.expenseDate })),
    ...invoices.filter((i) => i.status === "paid").map((i) => ({ clubId: i.clubId, category: i.expenseCategory ?? "other", amountKopeks: i.amountKopeks, expenseDate: i.paidAt ?? i.invoiceDate ?? i.createdAt })),
    ...refunds.filter((r) => r.status === "paid").map((r) => ({ clubId: r.clubId, category: "refunds", amountKopeks: r.amountKopeks, expenseDate: r.paidAt ?? r.refundDate ?? r.createdAt })),
  ];

  // Block 6: recent realized spending (table rows). Each row links to its source.
  const recentExpenseRows = [
    ...expenses.filter((e) => e.status === "confirmed").map((e) => ({ id: `exp-${e.id}`, href: `/expenses/${e.id}`, date: e.expenseDate, clubName: e.club.name, category: expenseCategoryLabel(e.category), amountKopeks: e.amountKopeks, type: "Расход" as const })),
    ...invoices.filter((i) => i.status === "paid").map((i) => ({ id: `inv-${i.id}`, href: `/invoices/${i.id}`, date: i.paidAt ?? i.invoiceDate ?? i.createdAt, clubName: i.club.name, category: expenseCategoryLabel(i.expenseCategory ?? "other"), amountKopeks: i.amountKopeks, type: "Счёт" as const })),
    ...refunds.filter((r) => r.status === "paid").map((r) => ({ id: `ref-${r.id}`, href: `/refunds/${r.id}`, date: r.paidAt ?? r.refundDate ?? r.createdAt, clubName: r.club.name, category: "Возвраты", amountKopeks: r.amountKopeks, type: "Возврат" as const })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 8);

  // Block 4: debts = approved-but-unpaid invoices + refunds, with overdue days.
  // Each row links to its source document.
  const APPROVED_UNPAID = ["approved_by_regional", "approved_by_owner"];
  const debts = [
    ...invoices.filter((i) => APPROVED_UNPAID.includes(i.status)).map((i) => ({ id: `inv-${i.id}`, href: `/invoices/${i.id}`, kind: "Счёт" as const, name: i.counterpartyName ?? "Без контрагента", amountKopeks: i.amountKopeks, dueDate: i.dueDate, clubName: i.club.name })),
    ...refunds.filter((r) => APPROVED_UNPAID.includes(r.status)).map((r) => ({ id: `ref-${r.id}`, href: `/refunds/${r.id}`, kind: "Возврат" as const, name: r.clientName ?? "Возврат клиенту", amountKopeks: r.amountKopeks, dueDate: r.refundDate, clubName: r.club.name })),
  ]
    .map((d) => ({ ...d, overdueDays: d.dueDate && d.dueDate.getTime() < now.getTime() ? Math.floor((now.getTime() - d.dueDate.getTime()) / 86_400_000) : 0 }))
    .sort((a, b) => b.overdueDays - a.overdueDays || (a.dueDate ? a.dueDate.getTime() : Infinity) - (b.dueDate ? b.dueDate.getTime() : Infinity) || b.amountKopeks - a.amountKopeks);
  const debtInvoices = debts.filter((d) => d.kind === "Счёт");
  const debtRefunds = debts.filter((d) => d.kind === "Возврат");
  const totalDebtKopeks = debts.reduce((s, d) => s + d.amountKopeks, 0);
  const overdueCount = debts.filter((d) => d.overdueDays > 0).length;

  // Sales: confirmed = revenue; pending = awaiting accountant.
  const confirmedSales = sales.filter((s) => s.status === "confirmed");
  const pendingSales = sales.filter((s) => s.status === "pending_accountant");
  const pendingSalesKopeks = pendingSales.reduce((s, x) => s + x.amountKopeks, 0);

  const salesSum = summarizeSales(confirmedSales, now);
  const expensesSum = summarizeExpenses(expenseEvents, now);
  const profit = profitSummary(salesSum, expensesSum);

  const planProgress = salesPlanProgress(salesPlan?.targetAmountKopeks ?? 0, profit.currentSalesKopeks);
  const planTargetRubles = salesPlan ? (salesPlan.targetAmountKopeks / 100).toString() : "";

  // Block 3: club ranking (per-club plan from the company's plans).
  const planByClub = new Map<string, number>();
  for (const p of planRows) if (p.clubId) planByClub.set(p.clubId, p.targetAmountKopeks);
  const ranking = clubRanking(clubs, confirmedSales, expenseEvents, now, planByClub);

  // Block 2 / 7: budget overruns + notifications (financial roles only).
  const overruns = financials ? computeBudgetOverruns(budgets, { expenses, invoices, refunds }, planMonth) : [];
  const overOver20 = overruns.filter((o) => o.overPercent > 20).length;

  // Budget-overrun approval requests pending a decision (financial roles only).
  const pendingApprovals = financials ? budgetRequests : [];
  const pendingApprovalRows = pendingApprovals.slice(0, 5).map((r) => ({
    id: r.id,
    clubName: r.club.name,
    category: budgetCategoryLabel(r.category),
    amountKopeks: r.requestedAmountKopeks,
    overrunKopeks: r.overrunKopeks > 0 ? r.overrunKopeks : r.overByAmountKopeks,
    by: r.requestedBy.name,
    date: r.createdAt,
  }));
  const pendingApprovalAmountKopeks = pendingApprovals.reduce((s, r) => s + r.requestedAmountKopeks, 0);

  const notifications = buildNotifications({
    financials,
    overdueCount,
    overrunCount: overruns.length,
    overOver20,
    budgetApprovalCount: pendingApprovals.length,
    planPercent: planProgress.percent,
    pendingCount: pendingSales.length,
  });

  const allClear = pendingSales.length === 0 && debts.length === 0 && overruns.length === 0;

  return (
    <div>
      <PageHeader title="Дашборд" description={`Состояние бизнеса · ${monthFormatter.format(now)}`} />

      {/* Block 1: главные показатели */}
      <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard label="Продажи" value={formatKopeks(profit.currentSalesKopeks)} />
        {financials ? <KpiCard label="Расходы" value={formatKopeks(profit.currentExpensesKopeks)} /> : null}
        {financials ? (
          <KpiCard
            label="Прибыль"
            value={formatKopeks(profit.currentProfitKopeks)}
            accent={profit.currentProfitKopeks >= 0 ? "text-emerald-700" : "text-rose-700"}
          />
        ) : null}
        <KpiCard
          label="Выполнение плана"
          value={planProgress.percent === null ? "—" : `${planProgress.percent.toFixed(0)}%`}
          sub={
            planProgress.planKopeks > 0
              ? `${formatKopeks(planProgress.factKopeks)} из ${formatKopeks(planProgress.planKopeks)}`
              : "план не задан"
          }
          accent={planTone(planProgress.percent)}
        />
      </div>

      {/* Plan detail + GD editor */}
      {planProgress.planKopeks > 0 || canEditPlan ? (
        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-700">
              План продаж · {monthFormatter.format(now)} ({planScopeLabel})
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span className="text-slate-500">План: <span className="font-medium text-slate-900">{formatKopeks(planProgress.planKopeks)}</span></span>
              <span className="text-slate-500">Факт: <span className="font-medium text-slate-900">{formatKopeks(planProgress.factKopeks)}</span></span>
              <span className="text-slate-500">Выполнение: <span className={`font-semibold ${planTone(planProgress.percent)}`}>{planProgress.percent === null ? "—" : `${planProgress.percent.toFixed(0)}%`}</span></span>
            </div>
          </div>
          {planProgress.planKopeks > 0 ? (
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, planProgress.percent ?? 0)}%` }} />
            </div>
          ) : null}
          {canEditPlan ? <SalesPlanForm month={planMonth} scopeLabel={planScopeLabel} currentTargetRubles={planTargetRubles} /> : null}
        </div>
      ) : null}

      {/* Block 2: требует внимания (financial roles) */}
      {financials ? (
        <CriticalBlock
          allClear={allClear}
          pending={{ count: pendingSales.length, kopeks: pendingSalesKopeks }}
          debtInvoices={{ count: debtInvoices.length, kopeks: debtInvoices.reduce((s, d) => s + d.amountKopeks, 0) }}
          debtRefunds={{ count: debtRefunds.length, kopeks: debtRefunds.reduce((s, d) => s + d.amountKopeks, 0) }}
          budgetOverCount={overruns.length}
        />
      ) : null}

      {/* Budget-overrun approvals awaiting a decision */}
      {financials && pendingApprovals.length > 0 ? (
        <div className="mb-6">
          <BudgetApprovalsBlock
            rows={pendingApprovalRows}
            total={pendingApprovals.length}
            amountKopeks={pendingApprovalAmountKopeks}
          />
        </div>
      ) : null}

      {/* Block 7: уведомления (приоритеты) */}
      <div className="mb-6">
        <NotificationsBlock notifications={notifications} />
      </div>

      {/* Block 3: рейтинг клубов */}
      {clubs.length > 1 ? (
        <div className="mb-6">
          <ClubRatingBlock rows={ranking} financials={financials} />
        </div>
      ) : null}

      {/* Block 4 + 5: долги | продажи на проверке */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {financials ? <DebtBlock rows={debts} totalKopeks={totalDebtKopeks} /> : null}
        <PendingSalesBlock
          rows={pendingSales.slice(0, 5).map((s) => ({ id: s.id, clubName: s.club.name, source: s.source, amountKopeks: s.amountKopeks, date: s.saleDate, by: s.createdBy.name }))}
          total={pendingSales.length}
        />
      </div>

      {/* Block 6: последние расходы */}
      {financials ? <RecentExpensesBlock rows={recentExpenseRows} /> : null}
    </div>
  );
}

// --- Block 2: критические показатели --------------------------------------

function CriticalBlock({
  allClear,
  pending,
  debtInvoices,
  debtRefunds,
  budgetOverCount,
}: {
  allClear: boolean;
  pending: { count: number; kopeks: number };
  debtInvoices: { count: number; kopeks: number };
  debtRefunds: { count: number; kopeks: number };
  budgetOverCount: number;
}) {
  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">Требует внимания</div>
      {allClear ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-inset ring-emerald-200">
          Критических отклонений нет
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <CriticalCard label="Продажи на проверке" main={`${pending.count} шт`} sub={formatKopeks(pending.kopeks)} tone={pending.count > 0 ? "amber" : "slate"} href={pending.count > 0 ? "/sales?status=pending_accountant" : undefined} />
          <CriticalCard label="Счета к оплате" main={`${debtInvoices.count} шт`} sub={formatKopeks(debtInvoices.kopeks)} tone={debtInvoices.count > 0 ? "rose" : "slate"} href={debtInvoices.count > 0 ? "#debts" : undefined} />
          <CriticalCard label="Возвраты к оплате" main={`${debtRefunds.count} шт`} sub={formatKopeks(debtRefunds.kopeks)} tone={debtRefunds.count > 0 ? "rose" : "slate"} href={debtRefunds.count > 0 ? "#debts" : undefined} />
          <CriticalCard label="Превышен бюджет" main={`${budgetOverCount} ${budgetOverCount === 1 ? "статья" : "статей"}`} sub={budgetOverCount > 0 ? "проверьте лимиты" : "в пределах"} tone={budgetOverCount > 0 ? "rose" : "slate"} href={budgetOverCount > 0 ? "/budgets" : undefined} />
        </div>
      )}
    </div>
  );
}

function CriticalCard({ label, main, sub, tone, href }: { label: string; main: string; sub: string; tone: "rose" | "amber" | "slate"; href?: string }) {
  const ring = tone === "rose" ? "border-rose-200 bg-rose-50" : tone === "amber" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50";
  const text = tone === "rose" ? "text-rose-800" : tone === "amber" ? "text-amber-800" : "text-slate-700";
  const inner = (
    <>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-0.5 text-base font-semibold ${text}`}>{main}</div>
      <div className="text-xs text-slate-500">{sub}</div>
    </>
  );
  if (!href) return <div className={`rounded-md border px-3 py-2 ${ring}`}>{inner}</div>;
  // Same-page anchors (#debts) use a plain <a>; route links use Next <Link>.
  const className = `block rounded-md border px-3 py-2 transition hover:shadow-sm ${ring}`;
  return href.startsWith("#") ? (
    <a href={href} className={className}>{inner}</a>
  ) : (
    <Link href={href} className={className}>{inner}</Link>
  );
}

// --- Block 7: уведомления --------------------------------------------------

type NoteTone = "red" | "yellow" | "green";
type Notification = { tone: NoteTone; text: string };

function buildNotifications(input: {
  financials: boolean;
  overdueCount: number;
  overrunCount: number;
  overOver20: number;
  budgetApprovalCount: number;
  planPercent: number | null;
  pendingCount: number;
}): Notification[] {
  const out: Notification[] = [];
  if (input.financials) {
    if (input.budgetApprovalCount > 0)
      out.push({
        tone: "red",
        text: `${input.budgetApprovalCount} ${pluralOverrun(input.budgetApprovalCount)} бюджета ожидают согласования`,
      });
    if (input.overdueCount > 0) out.push({ tone: "red", text: `Просроченные долги: ${input.overdueCount}` });
    if (input.overOver20 > 0) out.push({ tone: "red", text: `Превышение бюджета более чем на 20%: ${input.overOver20} стат.` });
  }
  if (input.planPercent !== null && input.planPercent < 50) {
    out.push({ tone: "red", text: `План выполнен менее чем на 50% (${input.planPercent.toFixed(0)}%)` });
  }
  if (input.pendingCount >= 3) {
    out.push({ tone: "yellow", text: `Много продаж на проверке: ${input.pendingCount}` });
  }
  if (input.financials && input.overrunCount > 0 && input.overOver20 === 0) {
    out.push({ tone: "yellow", text: `Превышен бюджет: ${input.overrunCount} стат.` });
  }
  if (input.planPercent !== null && input.planPercent >= 50 && input.planPercent < 80) {
    out.push({ tone: "yellow", text: `План выполнен менее чем на 80% (${input.planPercent.toFixed(0)}%)` });
  }
  if (out.length === 0) out.push({ tone: "green", text: "Всё в порядке" });
  return out.slice(0, 5);
}

/** Russian plural for "превышение" (overrun): 1→ение, 2-4→ения, else→ений. */
function pluralOverrun(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "превышение";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "превышения";
  return "превышений";
}

function NotificationsBlock({ notifications }: { notifications: Notification[] }) {
  const cls: Record<NoteTone, string> = {
    red: "bg-rose-50 text-rose-700 ring-rose-200",
    yellow: "bg-amber-50 text-amber-800 ring-amber-200",
    green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  };
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">Уведомления</div>
      <ul className="space-y-2">
        {notifications.map((n, i) => (
          <li key={i} className={`rounded-md px-3 py-2 text-sm ring-1 ring-inset ${cls[n.tone]}`}>
            {n.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Budget approvals (overrun requests) ----------------------------------

function BudgetApprovalsBlock({
  rows,
  total,
  amountKopeks,
}: {
  rows: Array<{ id: string; clubName: string; category: string; amountKopeks: number; overrunKopeks: number; by: string; date: Date }>;
  total: number;
  amountKopeks: number;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-rose-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-200 bg-rose-50 px-4 py-3">
        <span className="text-sm font-semibold text-rose-800">
          Согласование бюджета · ожидают: {total}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-rose-800">{formatKopeks(amountKopeks)}</span>
          <Link href="/budgets#approvals" className="text-xs font-medium text-brand-600 hover:text-brand-700">
            Открыть согласования
          </Link>
        </div>
      </div>
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-white">
          <tr>
            <Th>Клуб</Th>
            <Th>Статья</Th>
            <Th className="text-right">Сумма</Th>
            <Th className="text-right">Перерасход</Th>
            <Th>Запросил</Th>
            <Th className="text-right">Дата</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-slate-50">
              <Td className="whitespace-nowrap">{r.clubName}</Td>
              <Td>{r.category}</Td>
              <Td className="whitespace-nowrap text-right font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</Td>
              <Td className="whitespace-nowrap text-right font-medium text-rose-700">{formatKopeks(r.overrunKopeks)}</Td>
              <Td className="whitespace-nowrap">{r.by}</Td>
              <Td className="whitespace-nowrap text-right text-slate-500">{dateFormatter.format(r.date)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Block 3: рейтинг клубов ----------------------------------------------

function ClubRatingBlock({ rows, financials }: { rows: ClubRankRow[]; financials: boolean }) {
  const hasData = rows.some((r) => r.salesKopeks > 0 || r.expensesKopeks > 0);
  const bestId = rows[0]?.clubId;
  const worstId = rows.length > 1 ? rows[rows.length - 1].clubId : undefined;
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
        Рейтинг клубов · текущий месяц
      </div>
      {!hasData ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">Недостаточно данных</div>
      ) : (
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-white">
            <tr>
              <Th>Клуб</Th>
              <Th className="text-right">Продажи</Th>
              {financials ? <Th className="text-right">Расходы</Th> : null}
              {financials ? <Th className="text-right">Прибыль</Th> : null}
              <Th className="text-right">План %</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.clubId} className="hover:bg-slate-50">
                <Td className="font-medium text-slate-900">
                  <span className="mr-1">{row.clubId === bestId ? "🥇" : row.clubId === worstId ? "🔻" : ""}</span>
                  {row.clubName}
                  {row.profitTrendPercent !== null ? (
                    <span className={`ml-2 text-xs ${row.profitTrendPercent >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                      {row.profitTrendPercent >= 0 ? "↑" : "↓"} {Math.abs(row.profitTrendPercent).toFixed(0)}%
                    </span>
                  ) : null}
                </Td>
                <Td className="text-right">{formatKopeks(row.salesKopeks)}</Td>
                {financials ? <Td className="text-right">{formatKopeks(row.expensesKopeks)}</Td> : null}
                {financials ? (
                  <Td className={`text-right font-medium ${row.profitKopeks >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                    {formatKopeks(row.profitKopeks)}
                  </Td>
                ) : null}
                <Td className="text-right">
                  {row.planPercent === null ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <span className={`font-medium ${planTone(row.planPercent)}`}>{row.planPercent.toFixed(0)}%</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- Block 4: долги --------------------------------------------------------

type DebtRow = {
  id: string;
  href: string;
  name: string;
  kind: "Счёт" | "Возврат";
  amountKopeks: number;
  dueDate: Date | null;
  clubName: string;
  overdueDays: number;
};

function DebtBlock({ rows, totalKopeks }: { rows: DebtRow[]; totalKopeks: number }) {
  return (
    <div id="debts" className="scroll-mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
        <span className="text-sm font-semibold text-slate-700">Долги</span>
        {totalKopeks > 0 ? <span className="text-sm font-semibold text-rose-700">{formatKopeks(totalKopeks)}</span> : null}
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">Нет неоплаченных обязательств.</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((row) => (
            <li key={row.id}>
              <Link href={row.href} className="flex items-start justify-between gap-3 px-4 py-3 transition hover:bg-slate-50">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-900">{row.name}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${row.kind === "Счёт" ? "bg-sky-50 text-sky-700 ring-sky-200" : "bg-violet-50 text-violet-700 ring-violet-200"}`}>
                      {row.kind}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-slate-500">
                    {row.clubName}
                    {row.dueDate ? ` · до ${dateFormatter.format(row.dueDate)}` : " · без срока"}
                  </div>
                </div>
                <div className="whitespace-nowrap text-right">
                  <div className="text-sm font-medium text-slate-900">{formatKopeks(row.amountKopeks)}</div>
                  {row.overdueDays > 0 ? (
                    <span className="mt-0.5 inline-flex rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 ring-1 ring-inset ring-rose-200">
                      Просрочено {row.overdueDays} дн.
                    </span>
                  ) : (
                    <div className="text-xs text-slate-400">в срок</div>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Block 5: продажи на проверке -----------------------------------------

function PendingSalesBlock({
  rows,
  total,
}: {
  rows: Array<{ id: string; clubName: string; source: string; amountKopeks: number; date: Date; by: string }>;
  total: number;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
        <span className="text-sm font-semibold text-slate-700">Продажи на проверке</span>
        <Link href="/sales?status=pending_accountant" className="text-xs font-medium text-brand-600 hover:text-brand-700">
          Открыть все{total > rows.length ? ` (${total})` : ""}
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">Нет продаж на проверке.</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((s) => (
            <li key={s.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900">{s.source}</div>
                <div className="truncate text-xs text-slate-500">{s.clubName} · {s.by}</div>
              </div>
              <div className="whitespace-nowrap text-right">
                <div className="text-sm font-medium text-slate-900">{formatKopeks(s.amountKopeks)}</div>
                <div className="text-xs text-slate-400">{dateFormatter.format(s.date)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Block 6: последние расходы -------------------------------------------

function RecentExpensesBlock({
  rows,
}: {
  rows: Array<{ id: string; href: string; date: Date; clubName: string; category: string; amountKopeks: number; type: "Расход" | "Счёт" | "Возврат" }>;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">Последние расходы</div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">Расходов пока нет.</div>
      ) : (
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-white">
            <tr>
              <Th>Дата</Th>
              <Th>Клуб</Th>
              <Th>Статья</Th>
              <Th>Тип</Th>
              <Th className="text-right">Сумма</Th>
              <Th className="text-right"></Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td className="whitespace-nowrap">{dateFormatter.format(r.date)}</Td>
                <Td>{r.clubName}</Td>
                <Td>{r.category}</Td>
                <Td>
                  <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">{r.type}</span>
                </Td>
                <Td className="whitespace-nowrap text-right font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Link href={r.href} className="text-xs font-medium text-brand-600 hover:text-brand-700">Открыть</Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- Small shared building blocks -----------------------------------------

function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-500">{label}</div>
      <div className={`mt-2 truncate text-2xl font-semibold ${accent ?? "text-slate-900"}`}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
