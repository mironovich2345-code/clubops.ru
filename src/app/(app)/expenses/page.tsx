import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getClubsInScope,
  getCurrentAccessContext,
  managerOwnFilter,
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
  EXPENSE_TYPE_LABELS,
  type ExpenseSummary,
} from "@/lib/expenses";
import { NoCompanyState } from "@/components/NoCompanyState";
import { V2_STATUS_LABELS } from "@/lib/expense-simplified";
import { getClubCashCards, type ClubCashCards } from "@/lib/club-cash-cards";
import { UnsentDrafts } from "./_components/UnsentDrafts";

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

// Four review-stage filters. Drafts are intentionally EXCLUDED from every filter
// (they live only in the author's "Не отправленные черновики" block). Legacy
// statuses stay visible in their bucket and are never rewritten in the DB:
// waiting_budget_approval → На проверке; confirmed → Проверенные;
// canceled/import_reverted → Отменённые.
const ON_REVIEW = ["pending_regional_budget_approval", "pending_owner_budget_approval", "pending_accountant_verification", "waiting_budget_approval"];
const VERIFIED = ["verified", "confirmed"];
const CANCELLED = ["cancelled", "canceled", "import_reverted"];
const STATUS_FILTERS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: "needs_correction", label: "Требуют исправления", match: (s) => s === "needs_correction" },
  { key: "review", label: "На проверке", match: (s) => ON_REVIEW.includes(s) },
  { key: "verified", label: "Проверенные", match: (s) => VERIFIED.includes(s) },
  { key: "cancelled", label: "Отменённые", match: (s) => CANCELLED.includes(s) },
];
// Default view when no ?status= is provided.
const DEFAULT_FILTER_KEY = "review";

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
  // A plain manager sees only their OWN expenses everywhere on this page (list,
  // drafts, category summary). Elevated roles see all records of their clubs.
  const ownCreatorId = ctx ? managerOwnFilter(ctx).createdByUserId : undefined;

  let clubs: Awaited<ReturnType<typeof getClubsInScope>>;
  let expenses: ExpenseRow[];
  if (groups) {
    const perCompany = await Promise.all(
      groups.byCompany.map((g) =>
        getExpensesForScope({ company: { id: g.companyId, name: g.companyName }, club: null, clubIds: g.clubIds }, ownCreatorId).then(
          (rows) => rows.map((r) => ({ ...r, companyName: g.companyName })),
        ),
      ),
    );
    expenses = perCompany.flat();
    clubs = [];
  } else {
    [clubs, expenses] = await Promise.all([getClubsInScope(scope), getExpensesForScope(scope, ownCreatorId)]);
  }
  const canCreate = ctx ? canCreateOperational(ctx.effectiveRoles) : false;
  const multiCompany = groups?.multiCompany ?? false;
  const returnQuery = groups ? buildReturnTo("expenses", sp as Record<string, string | undefined>) : "";

  const statusParam = sp.status;
  const statusFilter = STATUS_FILTERS.find((f) => f.key === statusParam)
    ?? STATUS_FILTERS.find((f) => f.key === DEFAULT_FILTER_KEY)!;
  // Drafts never appear in the review filters — only in the author's own block.
  const visibleExpenses = expenses.filter((e) => e.status !== "draft" && statusFilter.match(e.status));

  // Author-only compact block: the current user's own unsent drafts. Other users'
  // drafts are never shown to anyone else.
  const myUserId = ctx?.user.id ?? null;
  const myDrafts = myUserId
    ? expenses
        .filter((e) => e.status === "draft" && e.createdBy.id === myUserId)
        .map((e) => ({
          id: e.id,
          title: e.generatedTitle || expenseCategoryLabel(e.category),
          dateText: dateFormatter.format(e.expenseDate),
          amountText: formatKopeks(e.amountKopeks),
          clubName: e.club.name,
        }))
    : [];

  const now = new Date();

  // Three summary cards for the SELECTED Club (single active ИП). Cards need one
  // Club; in a multi-Club/strategic view we prompt to pick one.
  const cardClubId = scope.club?.id ?? (scope.clubIds.length === 1 ? scope.clubIds[0] : null);
  const cards = !groups && cardClubId ? await getClubCashCards(cardClubId, now) : null;
  // Strategic/accounting roles see combined Club+regional cash; a plain manager
  // sees only the Club wallet (never regional wallet details).
  const allWallets = ctx ? ctx.effectiveRoles.some((r) => ["owner", "general_director", "regional_director", "accountant", "chief_accountant"].includes(r)) : false;

  // Retained "Расходы по статьям" sidebar — realized spend only (legacy confirmed
  // + v2 verified), so v2 expenses appear once they are verified.
  const summary = summarizeExpenses(
    expenses.filter((e) => e.status === "confirmed" || e.status === "verified"),
    now,
  );
  const currentMonthLabel = monthFormatter.format(now);

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
        <PageHeader title="Расходы" description="Наличные расходы ИП, документы и согласование" />
        {canCreate ? (
          <div className="flex flex-wrap gap-2">
            <Link href="/expenses/cash" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
              Касса
            </Link>
            <Link href="/expenses/simple" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
              + Новый расход
            </Link>
          </div>
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

      <CashCards cards={cards} multiClub={!groups && !cardClubId} allWallets={allWallets} />

      {/* Status filter */}
      <div className="mb-3 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === DEFAULT_FILTER_KEY ? "/expenses" : `/expenses?status=${f.key}`}
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

      <UnsentDrafts drafts={myDrafts} />

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

// Three cards for the selected Club: ИП cash balance, yesterday's ИП cash inflow,
// «Иное» income this month. Responsive: 1 col (mobile) → 2 (sm) → 3 (lg), no
// horizontal overflow; values use ₽ formatting; safe warnings never shift layout.
const cardsDayFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
function CashCards({ cards, multiClub, allWallets }: { cards: ClubCashCards | null; multiClub: boolean; allWallets: boolean }) {
  if (multiClub) {
    return (
      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm">
        Выберите один клуб, чтобы увидеть остаток наличных ИП и приходы.
      </div>
    );
  }
  if (!cards) return null;

  // Card 1 differs by role: strategic/accounting see the combined Club+regional
  // total (with breakdown); a manager sees ONLY the Club wallet.
  const card1Title = allWallets ? "Всего наличных ИП" : "Остаток наличных ИП в клубе";
  const card1Sub = allWallets ? "В клубе + у регионалов" : "Фактически находится в клубе";
  const card1Value = allWallets ? cards.combinedKopeks : cards.clubBalanceKopeks;

  return (
    <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Card label={card1Title} sub={card1Sub} accent={card1Value < 0 ? "text-rose-700" : "text-slate-900"}>
        {cards.ip.multiple ? (
          <span className="text-sm font-medium text-amber-700">Несколько активных ИП — настройте одно</span>
        ) : !cards.ip.configured ? (
          <span className="text-sm font-medium text-amber-700">Нет активного ИП</span>
        ) : !cards.hasOpeningBalance ? (
          <span className="text-sm font-medium text-amber-700">Требуется задать начальный остаток</span>
        ) : (
          <>
            {formatKopeks(card1Value)}
            {allWallets ? (
              <div className="mt-1 text-xs font-normal text-slate-500">
                В клубе: {formatKopeks(cards.clubBalanceKopeks)} · У регионалов: {formatKopeks(cards.regionalTotalKopeks)}
              </div>
            ) : cards.transferredToRegionalTotalKopeks > 0 ? (
              <div className="mt-1 text-xs font-normal text-slate-500">
                Передано региональному директору: {formatKopeks(cards.transferredToRegionalTotalKopeks)}
              </div>
            ) : null}
          </>
        )}
      </Card>
      <Card label="Приход наличных по ИП вчера" sub={cardsDayFmt.format(cards.yesterdayDate)} accent="text-slate-900">
        {formatKopeks(cards.yesterdayOfdKopeks)}
      </Card>
      <Card label="Приход «Иное»" sub="За текущий месяц" accent="text-slate-900">
        {formatKopeks(cards.otherIncomeMonthKopeks)}
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
