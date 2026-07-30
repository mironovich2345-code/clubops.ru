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
import { isExpenseOnReview, isExpenseNeedsCorrection, isExpenseVerified, isExpenseCancelled } from "@/lib/expense-status";
import { loadClubCashBalances } from "@/lib/cash-collections";
import { IpCashSyncButton, OpeningBalanceForm } from "../collections/_components/CollectionForms";
import { UnsentDrafts } from "./_components/UnsentDrafts";
import { MobileListCard } from "@/components/mobile/MobileListCard";
import { buttonClass } from "@/components/mobile/buttons";

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

// Four review-stage filters, driven by the SHARED status buckets (src/lib/expense-status.ts)
// — the exact same definitions the ИП cash card uses, so the two can't drift. Drafts are
// intentionally EXCLUDED from every filter (author's "Не отправленные черновики" block).
// `submitted` now lives in «На проверке» (previously it was in NO filter yet counted by
// the card — the invisible-expense reconciliation gap).
const STATUS_FILTERS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: "needs_correction", label: "Требуют исправления", match: isExpenseNeedsCorrection },
  { key: "review", label: "На проверке", match: isExpenseOnReview },
  { key: "verified", label: "Проверенные", match: isExpenseVerified },
  { key: "cancelled", label: "Отменённые", match: isExpenseCancelled },
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

  // Single ИП cash view for the SELECTED Club (single active ИП), aligned to the
  // fact-balance logic (src/lib/cash-balances.ts). Needs one Club; a multi-Club /
  // strategic view prompts to pick one. The wallet ledger stays at /expenses/cash.
  const cardClubId = !groups ? (scope.club?.id ?? (scope.clubIds.length === 1 ? scope.clubIds[0] : null)) : null;

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
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <PageHeader title="Расходы" description="Наличные расходы ИП, документы и согласование" />
        {canCreate ? (
          // Mobile: two equal-height full-width actions (stack < 380px); desktop: inline.
          <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2 lg:flex lg:w-auto lg:shrink-0">
            <Link href="/collections" className={buttonClass({ variant: "secondary" })}>Инкассация и остатки</Link>
            <Link href="/expenses/simple" className={buttonClass({ variant: "primary" })}>+ Новый расход</Link>
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

      <div className="mt-4">
        {cardClubId ? (
          <IpCashFactBlock companyId={scope.company.id} club={{ id: cardClubId, name: clubs.find((c) => c.id === cardClubId)?.name ?? "" }} today={iso(now)} />
        ) : (
          <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900">Выберите один клуб, чтобы увидеть фактический остаток наличных ИП.</div>
        )}
      </div>

      {/* Status filter — single row, horizontal scroll inside the container (no chaotic
          wrap); a right-edge fade signals that more statuses are scrollable (spec §6).
          Chips keep a fixed size whether active or not. */}
      <div className="relative -mx-4 mb-3 lg:mx-0">
        <div className="flex gap-2 overflow-x-auto px-4 pb-1 lg:flex-wrap lg:px-0">
          {STATUS_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === DEFAULT_FILTER_KEY ? "/expenses" : `/expenses?status=${f.key}`}
              className={`inline-flex min-h-[40px] shrink-0 items-center whitespace-nowrap rounded-full border px-3.5 text-sm font-medium ${
                statusFilter.key === f.key
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[var(--background)] to-transparent lg:hidden" aria-hidden />
      </div>

      <UnsentDrafts drafts={myDrafts} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          {/* Desktop table (≥lg). Mobile uses cards below (spec §4). */}
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm lg:block">
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

          {/* Mobile cards (<lg) — no horizontal scroll, one column (spec §4). */}
          <div className="space-y-3 lg:hidden">
            {visibleExpenses.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500">
                {expenses.length === 0
                  ? "Пока нет расходов. Загрузите чек/перевод или заполните вручную."
                  : "Нет расходов с выбранным статусом."}
              </div>
            ) : (
              visibleExpenses.map((expense) => {
                const contra = expense.vendorName ?? expense.recipientName ?? null;
                return (
                  <MobileListCard
                    key={expense.id}
                    href={groups ? undefined : `/expenses/${expense.id}`}
                    title={expenseCategoryLabel(expense.category)}
                    amount={formatKopeks(expense.amountKopeks)}
                    status={<ExpenseStatusBadge status={expense.status} />}
                    meta={[
                      { label: "Дата", value: dateFormatter.format(expense.expenseDate) },
                      { label: "Тип", value: EXPENSE_TYPE_LABELS[expense.type] ?? expense.type },
                      { label: "Клуб", value: `${multiCompany && expense.companyName ? expense.companyName + " · " : ""}${expense.club.name}` },
                      ...(contra ? [{ label: "Контрагент", value: contra }] : []),
                    ]}
                    action={groups ? (
                      <form action={openStrategicExpense}>
                        <input type="hidden" name="companyId" value={expense.companyId} />
                        <input type="hidden" name="objectId" value={expense.id} />
                        <input type="hidden" name="returnTo" value={returnQuery} />
                        <button type="submit" className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
                          Открыть
                        </button>
                      </form>
                    ) : undefined}
                  />
                );
              })
            )}
          </div>
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

// ИП cash "фактический остаток" — pending operations already counted. Managerial
// view (separate from the confirmed-only wallet ledger). Links to /collections.
// Single, aligned ИП cash view (same src/lib/cash-balances.ts logic as /collections
// and the dashboard). Fact balance from the latest control checkpoint; «Изъятия из
// ООО» shown as its own line (not mixed with «Иное»).
async function IpCashFactBlock({ companyId, club, today }: { companyId: string; club: { id: string; name: string }; today: string }) {
  const { balances: b, ipName } = await loadClubCashBalances(companyId, club.id);
  return (
    <div className="mb-6 rounded-lg border border-brand-200 bg-brand-50/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-semibold text-slate-700">Наличные ИП{ipName ? ` — ${ipName}` : ""}</div>
        <IpCashSyncButton />
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{formatKopeks(b.cashIpFactBalance)}</div>
      <div className="text-xs text-slate-500">{b.cashIpOpeningSet ? "Фактический остаток ИП сейчас" : "Расчётный остаток ИП от 0 ₽"}</div>
      {!b.cashIpOpeningSet ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Начальный остаток не задан. Укажите контрольный остаток кассы ИП, чтобы расчёт был точным.</div>
      ) : null}
      <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm min-[400px]:grid-cols-2 sm:grid-cols-3">
        <FactRow label={`Контрольный остаток${b.cashIpOpeningDate ? ` (${b.cashIpOpeningDate})` : ""}`} value={b.cashIpOpeningSet ? formatKopeks(b.cashIpOpening) : "не задан"} />
        <FactRow label="Приход ИП вчера (ОФД)" value={formatKopeks(b.cashIpOfdYesterday)} />
        <FactRow label="Приход ИП сегодня (ОФД)" value={formatKopeks(b.cashIpOfdToday)} />
        <FactRow label="ОФД наличные за месяц" value={formatKopeks(b.cashIpOfdMonth)} />
        <FactRow label="Изъятия из ООО" value={formatKopeks(b.cashIpWithdrawalsFromOoo)} />
        <FactRow label="Приход «Иное»" value={formatKopeks(b.cashIpOtherIncome)} />
        <FactRow label="Передано регионалу (подтв.)" value={formatKopeks(b.cashIpRegionalTransfers)} />
        <FactRow label="Расходы ИП на проверке" value={formatKopeks(b.cashIpPendingExpenses)} />
        <FactRow label="Подтверждённые расходы ИП" value={formatKopeks(b.cashIpApprovedExpenses)} />
      </div>
      {/* The card is deliberately a NARROWER set than the list below: only THIS club's
          наличные-ИП расходы (paymentMethod=cash, ИП, v2). «На проверке» здесь = статусы
          «На проверке» + «Требуют исправления» из общего списка. Поэтому суммы карточки и
          общего списка расходов совпадать не обязаны (общий список шире по клубам/юрлицам). */}
      <p className="mt-2 text-xs text-slate-400">
        Только наличные расходы ИП этого клуба (на проверке = ожидают проверки и на исправлении). Общий список расходов ниже шире — по всем клубам и юрлицам в выборке.
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-brand-700">Задать контрольный остаток ИП</summary>
        <div className="mt-3 border-t border-brand-100 pt-3">
          <OpeningBalanceForm clubs={[club]} today={today} entity="ip" />
        </div>
      </details>
      <div className="mt-3 flex flex-wrap gap-4">
        <a href="/collections" className="text-xs font-medium text-brand-700 hover:underline">Добавить приход «Иное» →</a>
        <a href="/collections" className="text-xs font-medium text-brand-700 hover:underline">Инкассация и изъятия →</a>
      </div>
    </div>
  );
}
function FactRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className={strong ? "font-semibold text-slate-900" : "font-medium text-slate-800"}>{value}</span>
    </div>
  );
}
