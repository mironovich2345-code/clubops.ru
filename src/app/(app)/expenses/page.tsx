import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getClubsInScope,
  getCurrentAccessContext,
} from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
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
import { ExpenseUpload } from "./_components/ExpenseUpload";
import { BulkCancelExpenses } from "./_components/BulkCancelExpenses";
import { ExcelImportPanel } from "@/components/ExcelImportPanel";
import { importExpenses } from "./expense-import-actions";
import { revertImportBatch } from "../import-revert-actions";
import { getLastImportBatch } from "@/lib/import-batches";
import { ExportButton } from "@/components/ExportButton";
import { canExport } from "@/lib/exports";

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

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requirePageAccess("expenses");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Расходы" description="Чеки, переводы и динамика по статьям" />;
  }

  const [clubs, expenses, ctx] = await Promise.all([
    getClubsInScope(scope),
    getExpensesForScope(scope),
    getCurrentAccessContext(),
  ]);
  const canCreate = ctx ? canCreateOperational(ctx.effectiveRoles) : false;

  const { status: statusParam } = await searchParams;
  const statusFilter = STATUS_FILTERS.find((f) => f.key === statusParam) ?? STATUS_FILTERS[0];
  const visibleExpenses = expenses.filter((e) => statusFilter.match(e.status));
  const lastImport = canCreate && ctx
    ? await getLastImportBatch(scope.company.id, "expenses", scope.clubIds, ctx.user.id)
    : null;

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

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="Расходы" description="Чеки, переводы и динамика по статьям" />
        {ctx && canExport(ctx.effectiveRoles, "expenses") ? <div className="pt-1"><ExportButton type="expenses" /></div> : null}
      </div>

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

      {/* Excel import (additional input method; manual form + AI upload unchanged) */}
      {canCreate && clubs.length > 0 ? (
        <ExcelImportPanel
          title="Импорт расходов из Excel"
          description="Скачайте шаблон, заполните и загрузите. Наличные расходы автоматически относятся на ИП клуба; превышение бюджета уходит на согласование."
          templateHref="/api/expenses/template"
          templateLabel="Скачать шаблон расходов"
          uploadLabel="Загрузить расходы из Excel"
          action={importExpenses}
          lastBatch={lastImport}
          revertAction={revertImportBatch}
        />
      ) : null}

      {/* Monthly bulk cancel (regional / manager-own-club) */}
      {canCreate && clubs.length > 0 ? (
        <BulkCancelExpenses
          clubs={clubs.map((c) => ({ id: c.id, name: c.name }))}
          categories={EXPENSE_CATEGORY_OPTIONS}
          defaultClubId={scope.club?.id ?? clubs[0].id}
          defaultMonth={`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`}
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
                      <div className="mt-1 text-xs text-slate-500">{expense.club.name}</div>
                      <ExpenseStatusBadge status={expense.status} />
                    </Td>
                    <Td>{expense.vendorName ?? expense.recipientName ?? "—"}</Td>
                    <Td className="whitespace-nowrap text-right font-medium text-slate-900">
                      {formatKopeks(expense.amountKopeks)}
                    </Td>
                    <Td className="whitespace-nowrap text-slate-600">{expense.createdBy.name}</Td>
                    <Td>
                      <Link
                        href={`/expenses/${expense.id}`}
                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Открыть
                      </Link>
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
}: {
  totals: ExpenseSummary["categoryTotals"];
  totalKopeks: number;
  monthLabel: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
        <div className="text-sm font-semibold text-slate-700">Расходы по статьям</div>
        <div className="text-xs text-slate-500">{monthLabel}</div>
      </div>
      {totals.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">
          Нет расходов в этом месяце.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {totals.map((item) => {
            const percent = totalKopeks > 0 ? (item.amountKopeks / totalKopeks) * 100 : 0;
            return (
              <li key={item.category} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-700">{expenseCategoryLabel(item.category)}</span>
                  <span className="text-sm font-medium text-slate-900">
                    {formatKopeks(item.amountKopeks)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-brand-500" style={{ width: `${percent}%` }} />
                </div>
                <div className="mt-1 text-right text-xs text-slate-400">{percent.toFixed(1)}%</div>
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
  return null;
}
