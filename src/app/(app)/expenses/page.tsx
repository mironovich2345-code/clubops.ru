import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth";
import { formatKopeks } from "@/lib/money";
import {
  getExpensesForScope,
  summarizeExpenses,
  type ExpenseSummary,
} from "@/lib/expenses";
import { getCurrentCompanyAndClub, getClubsInScope } from "@/lib/access";
import { NoCompanyState } from "@/components/NoCompanyState";
import { CreateExpenseForm } from "./_components/CreateExpenseForm";

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

export default async function ExpensesPage() {
  const user = await requirePageAccess("expenses");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return (
      <NoCompanyState title="Расходы" description="Учёт расходов клуба и динамика по статьям" />
    );
  }

  const [clubs, expenses] = await Promise.all([
    getClubsInScope(scope),
    getExpensesForScope(scope),
  ]);

  const now = new Date();
  const summary = summarizeExpenses(expenses, now);
  const currentMonthLabel = monthFormatter.format(now);
  const previousMonthLabel = monthFormatter.format(
    new Date(now.getFullYear(), now.getMonth() - 1, 1),
  );

  return (
    <div>
      <PageHeader title="Расходы" description="Учёт расходов клуба и динамика по статьям" />

      <SummarySection
        summary={summary}
        currentMonthLabel={currentMonthLabel}
        previousMonthLabel={previousMonthLabel}
      />

      <CreateExpenseForm clubs={clubs} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Дата</Th>
                <Th>Статья</Th>
                <Th>Поставщик</Th>
                <Th className="text-right">Сумма</Th>
                <Th>Способ оплаты</Th>
                <Th>Комментарий</Th>
                <Th>Кто добавил</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {expenses.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-500">
                    Пока нет расходов. Нажмите «Добавить расход», чтобы создать первый.
                  </td>
                </tr>
              ) : (
                expenses.map((expense) => (
                  <tr key={expense.id} className="hover:bg-slate-50">
                    <Td className="whitespace-nowrap">
                      {dateFormatter.format(expense.expenseDate)}
                    </Td>
                    <Td>
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200">
                        {expense.category}
                      </span>
                      <div className="mt-1 text-xs text-slate-500">{expense.club.name}</div>
                    </Td>
                    <Td>{expense.vendorName ?? "—"}</Td>
                    <Td className="whitespace-nowrap text-right font-medium text-slate-900">
                      {formatKopeks(expense.amountKopeks)}
                    </Td>
                    <Td className="whitespace-nowrap">{expense.paymentMethod ?? "—"}</Td>
                    <Td className="max-w-xs">
                      <div className="line-clamp-2 text-slate-600">{expense.comment ?? "—"}</div>
                    </Td>
                    <Td className="whitespace-nowrap text-slate-600">{expense.createdBy.name}</Td>
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
        {summary.largestCategory ? summary.largestCategory.category : "—"}
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
                  <span className="text-sm text-slate-700">{item.category}</span>
                  <span className="text-sm font-medium text-slate-900">
                    {formatKopeks(item.amountKopeks)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-brand-500"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="mt-1 text-right text-xs text-slate-400">
                  {percent.toFixed(1)}%
                </div>
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

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
