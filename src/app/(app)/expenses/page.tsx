import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getClubsInScope,
  getCurrentAccessContext,
} from "@/lib/access";
import { canCreateOperational, isStrategicRole } from "@/lib/auth";
import { resolveStrategicGroups, strategicQuery } from "@/lib/strategic-pages";
import { StrategicScopeFilter } from "../dashboard/_components/StrategicScopeFilter";
import { openStrategicExpense } from "../dashboard/strategic-actions";
import { buildReturnTo } from "@/lib/strategic-return";
import { formatKopeks } from "@/lib/money";
import {
  getExpensesForScope,
  summarizeExpenses,
  expenseCategoryLabel,
  expenseStatusLabel,
  EXPENSE_CATEGORY_OPTIONS,
  EXPENSE_TYPE_LABELS,
  EXPENSE_ACTIVE_STATUSES,
  type ExpenseSummary,
} from "@/lib/expenses";
import { NoCompanyState } from "@/components/NoCompanyState";
import { getClubLegalEntities, normalizeEntityType } from "@/lib/legal-entities";
import { V2_STATUS_LABELS } from "@/lib/expense-simplified";
import { ExpenseUpload } from "./_components/ExpenseUpload";

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

const STATUS_FILTERS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: "active", label: "Активные", match: (s) => (EXPENSE_ACTIVE_STATUSES as readonly string[]).includes(s) },
  { key: "confirmed", label: "Подтверждённые", match: (s) => s === "confirmed" },
  { key: "waiting_budget_approval", label: "Ожидают бюджет", match: (s) => s === "waiting_budget_approval" },
  { key: "canceled", label: "Отменённые", match: (s) => s === "canceled" },
  { key: "import_reverted", label: "Импорт отменён", match: (s) => s === "import_reverted" },
  { key: "all", label: "Все", match: () => true },
];

type ExpenseRow = Awaited<ReturnType<typeof getExpensesForScope>>[number] & { companyName?: string };

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; scopeMode?: string; companyId?: string; city?: string; clubId?: string }>;
}) {
  const user = await requirePageAccess("expenses");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Расходы" description="Чеки, переводы и динамика по статьям" />;
  }

  const sp = await searchParams;
  const ctx = await getCurrentAccessContext();
  // Strategic owner/GD: read-only expense analytics across ALL filtered Companies.
  // Non-strategic roles keep the single-Company experience.
  const strategic = ctx ? isStrategicRole(ctx.effectiveRoles) : false;
  const groups = strategic && ctx ? await resolveStrategicGroups(ctx, sp) : null;

  let clubs: Awaited<ReturnType<typeof getClubsInScope>>;
  let expenses: ExpenseRow[];
  if (groups) {
    const perCompany = await Promise.all(
      groups.byCompany.map((g) =>
        getExpensesForScope({ company: { id: g.companyId, name: g.companyName }, club: null, clubIds: g.clubIds }).then(
          (rows) => rows.map((r) => ({ ...r, companyName: g.companyName })),
        ),
      ),
    );
    expenses = perCompany.flat();
    clubs = [];
  } else {
    [clubs, expenses] = await Promise.all([getClubsInScope(scope), getExpensesForScope(scope)]);
  }
  const canCreate = ctx ? canCreateOperational(ctx.effectiveRoles) : false;
  const multiCompany = groups?.multiCompany ?? false;
  const returnQuery = groups ? buildReturnTo("expenses", sp as Record<string, string | undefined>) : "";

  const statusParam = sp.status;
  const statusFilter = STATUS_FILTERS.find((f) => f.key === statusParam) ?? STATUS_FILTERS[0];
  const visibleExpenses = expenses.filter((e) => statusFilter.match(e.status));

  // Active legal entities per club for the expense form (cash -> ИП routing).
  const legalEntitiesByClub: Record<string, Array<{ id: string; name: string; type: string; inn: string | null }>> = {};
  if (canCreate) {
    const lists = await Promise.all(clubs.map((c) => getClubLegalEntities(c.id)));
    clubs.forEach((c, i) => {
      legalEntitiesByClub[c.id] = lists[i].map((e) => ({
        id: e.id,
        name: e.name,
        type: normalizeEntityType(e.type) ?? e.type,
        inn: e.inn,
      }));
    });
  }

  const now = new Date();
  // Analytics/totals reflect realized spend only — expenses waiting for or
  // rejected by budget approval do not count.
  const summary = summarizeExpenses(
    expenses.filter((e) => e.status === "confirmed"),
    now,
  );
  const currentMonthLabel = monthFormatter.format(now);
  const previousMonthLabel = monthFormatter.format(
    new Date(now.getFullYear(), now.getMonth() - 1, 1),
  );

  // Category drilldown into the existing read-only /analytics/expenses view.
  // Enabled for analytical (financial) roles — owner / GD / regional / accountant
  // (chief accountant inherits accountant). source=expense so the drilldown total
  // matches the expense category card exactly.
  const DRILL_ROLES = ["owner", "general_director", "regional_director", "accountant"];
  const drillEnabled = ctx ? ctx.effectiveRoles.some((r) => DRILL_ROLES.includes(r)) : false;
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const drill = drillEnabled
    ? {
        from: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
        // Carry the strategic scope into the drilldown so its total matches this
        // page's category card exactly (same Companies/Clubs).
        qs: groups ? `&${strategicQuery(groups.scope, null)}` : "",
      }
    : null;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="Расходы" description="Чеки, переводы и динамика по статьям" />
        {canCreate ? (
          <Link href="/expenses/simple" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
            + Новый расход
          </Link>
        ) : null}
      </div>

      {groups && groups.scope.accessibleClubs.length > 0 ? (
        <div className="mt-3">
          <StrategicScopeFilter
            companies={groups.scope.accessibleCompanies}
            clubs={groups.scope.accessibleClubs}
            mode={groups.scope.mode}
            companyId={groups.scope.selectedCompanyId}
            city={groups.scope.selectedCity}
            clubId={groups.scope.selectedClubId}
            month=""
            basePath="/expenses"
            extra={statusParam ? { status: statusParam } : {}}
          />
        </div>
      ) : null}

      <SummarySection
        summary={summary}
        currentMonthLabel={currentMonthLabel}
        previousMonthLabel={previousMonthLabel}
      />

      {canCreate && clubs.length > 0 ? (
        <ExpenseUpload
          clubs={clubs}
          categories={EXPENSE_CATEGORY_OPTIONS}
          companyName={scope.company.name}
          legalEntitiesByClub={legalEntitiesByClub}
        />
      ) : null}


      {/* Status filter */}
      <div className="mb-3 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "active" ? "/expenses" : `/expenses?status=${f.key}`}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
              statusFilter.key === f.key
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
                <Th>Тип</Th>
                <Th>Статья</Th>
                <Th>Контрагент</Th>
                <Th className="text-right">Сумма</Th>
                <Th>Кто добавил</Th>
                <Th>Действия</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {visibleExpenses.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-500">
                    {expenses.length === 0
                      ? "Пока нет расходов. Загрузите чек/перевод или заполните вручную."
                      : "Нет расходов с выбранным статусом."}
                  </td>
                </tr>
              ) : (
                visibleExpenses.map((expense) => (
                  <tr key={expense.id} className="hover:bg-slate-50">
                    <Td className="whitespace-nowrap">{dateFormatter.format(expense.expenseDate)}</Td>
                    <Td className="whitespace-nowrap">
                      {EXPENSE_TYPE_LABELS[expense.type] ?? expense.type}
                    </Td>
                    <Td>
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200">
                        {expenseCategoryLabel(expense.category)}
                      </span>
                      <div className="mt-1 text-xs text-slate-500">
                        {multiCompany && expense.companyName ? `${expense.companyName} · ` : ""}{expense.club.name}
                      </div>
                      <ExpenseStatusBadge status={expense.status} />
                    </Td>
                    <Td>{expense.vendorName ?? expense.recipientName ?? "—"}</Td>
                    <Td className="whitespace-nowrap text-right font-medium text-slate-900">
                      {formatKopeks(expense.amountKopeks)}
                    </Td>
                    <Td className="whitespace-nowrap text-slate-600">{expense.createdBy.name}</Td>
                    <Td>
                      {groups ? (
                        <form action={openStrategicExpense}>
                          <input type="hidden" name="companyId" value={expense.companyId} />
                          <input type="hidden" name="objectId" value={expense.id} />
                          <input type="hidden" name="returnTo" value={returnQuery} />
                          <button type="submit" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                            Открыть
                          </button>
                        </form>
                      ) : (
                        <Link
                          href={`/expenses/${expense.id}`}
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Открыть
                        </Link>
                      )}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <CategoryAnalytics
          totals={summary.categoryTotals}
          totalKopeks={summary.currentMonthKopeks}
          monthLabel={currentMonthLabel}
          drill={drill}
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
  summary: ExpenseSummary;
  currentMonthLabel: string;
  previousMonthLabel: string;
}) {
  const changeUp = summary.changeKopeks > 0;
  const changeDown = summary.changeKopeks < 0;
  const changeAccent = changeUp
    ? "text-rose-700"
    : changeDown
      ? "text-emerald-700"
      : "text-slate-600";
  const sign = changeUp ? "+" : "";
  const percentText =
    summary.changePercent === null
      ? "нет данных за прошлый месяц"
      : `${sign}${summary.changePercent.toFixed(1)}% к прошлому месяцу`;

  return (
    <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card label="Расходы за месяц" sub={currentMonthLabel} accent="text-slate-900">
        {formatKopeks(summary.currentMonthKopeks)}
      </Card>
      <Card label="Прошлый месяц" sub={previousMonthLabel} accent="text-slate-900">
        {formatKopeks(summary.previousMonthKopeks)}
      </Card>
      <Card label="Изменение" sub={percentText} accent={changeAccent}>
        {`${sign}${formatKopeks(summary.changeKopeks)}`}
      </Card>
      <Card
        label="Крупнейшая статья"
        sub={
          summary.largestCategory
            ? formatKopeks(summary.largestCategory.amountKopeks)
            : "нет расходов в этом месяце"
        }
        accent="text-slate-900"
      >
        {summary.largestCategory ? expenseCategoryLabel(summary.largestCategory.category) : "—"}
      </Card>
    </div>
  );
}

function CategoryAnalytics({
  totals,
  totalKopeks,
  monthLabel,
  drill,
}: {
  totals: ExpenseSummary["categoryTotals"];
  totalKopeks: number;
  monthLabel: string;
  drill: { from: string; to: string; qs: string } | null;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
        <div className="text-sm font-semibold text-slate-700">Расходы по статьям</div>
        <div className="text-xs text-slate-500">{monthLabel}{drill ? " · нажмите статью для детализации" : ""}</div>
      </div>
      {totals.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">
          Нет расходов в этом месяце.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {totals.map((item) => {
            const percent = totalKopeks > 0 ? (item.amountKopeks / totalKopeks) * 100 : 0;
            const label = expenseCategoryLabel(item.category);
            const inner = (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-700">{label}</span>
                  <span className="text-sm font-medium text-slate-900">{formatKopeks(item.amountKopeks)}</span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-brand-500" style={{ width: `${percent}%` }} />
                </div>
                <div className="mt-1 text-right text-xs text-slate-400">{percent.toFixed(1)}%</div>
              </>
            );
            return (
              <li key={item.category}>
                {drill ? (
                  <Link
                    href={`/analytics/expenses?category=${encodeURIComponent(item.category)}&source=expense&from=${drill.from}&to=${drill.to}${drill.qs}`}
                    className="block px-4 py-3 transition hover:bg-slate-50"
                  >
                    {inner}
                  </Link>
                ) : (
                  <div className="px-4 py-3">{inner}</div>
                )}
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

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}

function ExpenseStatusBadge({ status }: { status: string }) {
  if (status === "waiting_budget_approval") {
    return (
      <div className="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
        Ожидает согласования бюджета
      </div>
    );
  }
  if (status === "budget_rejected") {
    return (
      <div className="mt-1 inline-flex rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 ring-1 ring-inset ring-rose-200">
        Отклонён (бюджет)
      </div>
    );
  }
  if (status === "canceled" || status === "import_reverted") {
    return (
      <div className="mt-1 inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
        {expenseStatusLabel(status)}
      </div>
    );
  }
  // Simplified (v2) workflow statuses.
  if (V2_STATUS_LABELS[status]) {
    const tone = status === "verified" ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : status === "needs_correction" ? "bg-amber-50 text-amber-800 ring-amber-200"
      : status === "cancelled" ? "bg-slate-100 text-slate-500 ring-slate-200"
      : "bg-sky-50 text-sky-700 ring-sky-200";
    return <div className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone}`}>{V2_STATUS_LABELS[status]}</div>;
  }
  return null;
}
