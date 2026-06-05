import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getCurrentAccessContext,
  getClubsInScope,
  getManageableClubIds,
} from "@/lib/access";
import {
  getBudgetOverview,
  getBudgetRequestsForScope,
  BUDGET_CATEGORIES,
  budgetCategoryLabel,
  currentMonthKey,
  isValidMonth,
  isBudgetRequestPending,
  BUDGET_REQUEST_STATUS_LABELS,
} from "@/lib/budgets";
import { BudgetLimitForm } from "./_components/BudgetForms";
import { RequestActions } from "./_components/RequestActions";

export const dynamic = "force-dynamic";

const REQUEST_TABS = [
  { key: "pending", label: "Ожидают" },
  { key: "approved", label: "Согласованы" },
  { key: "rejected", label: "Отклонены" },
] as const;

type RequestTab = (typeof REQUEST_TABS)[number]["key"];

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ clubId?: string; month?: string; tab?: string }>;
}) {
  const user = await requirePageAccess("budgets");
  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Бюджеты" description="Месячные лимиты и согласование перерасхода" />;
  }

  const ctx = await getCurrentAccessContext();
  const clubs = await getClubsInScope(scope);
  if (!ctx || clubs.length === 0) {
    return <NoCompanyState title="Бюджеты" description="Месячные лимиты и согласование перерасхода" />;
  }

  const sp = await searchParams;
  const selectedClubId =
    sp.clubId && clubs.some((c) => c.id === sp.clubId) ? sp.clubId : scope.club?.id ?? clubs[0].id;
  const now = new Date();
  const month = sp.month && isValidMonth(sp.month) ? sp.month : currentMonthKey(now);
  const tab: RequestTab = REQUEST_TABS.some((t) => t.key === sp.tab)
    ? (sp.tab as RequestTab)
    : "pending";

  const [overview, requests, manageableClubIds] = await Promise.all([
    getBudgetOverview(selectedClubId, month),
    getBudgetRequestsForScope(scope),
    getManageableClubIds(user.id, scope.company.id),
  ]);
  const manageable = new Set(manageableClubIds);
  const canManageSelected = manageable.has(selectedClubId);

  // Approval rights: owner/GD -> all clubs, RD -> assigned clubs (encoded by
  // getManageableClubIds); the requester may never decide their own request.
  function canDecide(req: (typeof requests)[number]): boolean {
    return (
      isBudgetRequestPending(req.status) &&
      manageable.has(req.clubId) &&
      req.requestedByUserId !== user.id
    );
  }

  const counts = {
    pending: requests.filter((r) => isBudgetRequestPending(r.status)).length,
    approved: requests.filter((r) => r.status === "approved").length,
    rejected: requests.filter((r) => r.status === "rejected").length,
  };
  const tabRequests = requests.filter((r) =>
    tab === "pending" ? isBudgetRequestPending(r.status) : r.status === tab,
  );

  const tabHref = (t: RequestTab) => {
    const params = new URLSearchParams({ clubId: selectedClubId, month, tab: t });
    return `/budgets?${params.toString()}`;
  };

  return (
    <div>
      <PageHeader title="Бюджеты" description="Месячные лимиты по статьям и согласование перерасхода" />

      {/* Club + month selector */}
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Клуб</span>
          <select name="clubId" defaultValue={selectedClubId} className="input">
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Месяц</span>
          <input type="month" name="month" defaultValue={month} className="input" />
        </label>
        <input type="hidden" name="tab" value={tab} />
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Показать
        </button>
      </form>

      {canManageSelected ? (
        <div className="mb-6">
          <BudgetLimitForm clubId={selectedClubId} month={month} categories={BUDGET_CATEGORIES} />
        </div>
      ) : null}

      {/* Overview */}
      <div className="mb-8 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
          Лимиты и использование · {month}
        </div>
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Статья</Th>
              <Th className="text-right">Лимит</Th>
              <Th className="text-right">Использовано</Th>
              <Th className="text-right">Остаток</Th>
              <Th className="text-right">% использования</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {overview.map((row) => {
              const over = row.hasLimit && row.remainingKopeks < 0;
              return (
                <tr key={row.category} className="hover:bg-slate-50">
                  <Td>{row.label}</Td>
                  <Td className="text-right">{row.hasLimit ? formatKopeks(row.limitKopeks) : "—"}</Td>
                  <Td className="text-right">{formatKopeks(row.usedKopeks)}</Td>
                  <Td className={`text-right font-medium ${over ? "text-rose-700" : "text-slate-900"}`}>
                    {row.hasLimit ? formatKopeks(row.remainingKopeks) : "—"}
                  </Td>
                  <Td className={`text-right ${over ? "text-rose-700" : "text-slate-700"}`}>
                    {row.percentUsed === null ? "—" : `${row.percentUsed.toFixed(0)}%`}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Budget approval requests */}
      <div id="approvals" className="scroll-mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
          Запросы на согласование перерасхода
        </div>
        <div className="flex flex-wrap gap-2 border-b border-slate-200 px-4 py-2">
          {REQUEST_TABS.map((t) => (
            <Link
              key={t.key}
              href={tabHref(t.key)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                t.key === tab
                  ? "bg-brand-600 text-white"
                  : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {t.label} ({counts[t.key]})
            </Link>
          ))}
        </div>
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Клуб</Th>
              <Th>Статья</Th>
              <Th className="text-right">Сумма</Th>
              <Th className="text-right">Бюджет</Th>
              <Th className="text-right">Прогноз</Th>
              <Th className="text-right">Перерасход</Th>
              <Th>Причина</Th>
              <Th>Запросил</Th>
              <Th>Статус</Th>
              <Th>Действия</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {tabRequests.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-sm text-slate-500">
                  Запросов в этой вкладке нет.
                </td>
              </tr>
            ) : (
              tabRequests.map((req) => (
                <tr key={req.id} className="hover:bg-slate-50">
                  <Td className="whitespace-nowrap">{req.club.name}</Td>
                  <Td>{budgetCategoryLabel(req.category)}</Td>
                  <Td className="whitespace-nowrap text-right">{formatKopeks(req.requestedAmountKopeks)}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {req.budgetAmountKopeks > 0 ? formatKopeks(req.budgetAmountKopeks) : "—"}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {req.projectedSpentKopeks > 0 ? formatKopeks(req.projectedSpentKopeks) : "—"}
                  </Td>
                  <Td className="whitespace-nowrap text-right font-medium text-rose-700">
                    {formatKopeks(req.overrunKopeks > 0 ? req.overrunKopeks : req.overByAmountKopeks)}
                  </Td>
                  <Td className="max-w-[16rem] truncate">{req.reason ?? "—"}</Td>
                  <Td className="whitespace-nowrap">{req.requestedBy.name}</Td>
                  <Td className="whitespace-nowrap">
                    {BUDGET_REQUEST_STATUS_LABELS[req.status] ?? req.status}
                  </Td>
                  <Td>
                    <RequestActions requestId={req.id} canDecide={canDecide(req)} />
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
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
