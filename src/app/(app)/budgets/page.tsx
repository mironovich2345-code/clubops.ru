import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getCurrentAccessContext,
  getClubsInScope,
  getManageableClubIds,
  userHasCompanyRole,
} from "@/lib/access";
import {
  getBudgetOverview,
  getBudgetRequestsForScope,
  BUDGET_CATEGORIES,
  budgetCategoryLabel,
  currentMonthKey,
  isValidMonth,
  BUDGET_REQUEST_STATUS_LABELS,
  OWNER_DOUBLE_CONFIRM_PERCENT,
} from "@/lib/budgets";
import { BudgetLimitForm, RequestForm } from "./_components/BudgetForms";
import { RequestActions } from "./_components/RequestActions";

export const dynamic = "force-dynamic";

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ clubId?: string; month?: string }>;
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

  const [overview, requests, isOwner, manageableClubIds] = await Promise.all([
    getBudgetOverview(selectedClubId, month),
    getBudgetRequestsForScope(scope),
    userHasCompanyRole(user.id, scope.company.id, ["owner"]),
    getManageableClubIds(user.id, scope.company.id),
  ]);
  const manageable = new Set(manageableClubIds);
  const canManageSelected = manageable.has(selectedClubId);

  function decisionFlags(req: (typeof requests)[number]) {
    const pending = req.status === "pending_regional" || req.status === "pending_owner";
    if (!pending) return { canApprove: false, canReject: false, requiresDoubleConfirm: false };
    const isClubManager = manageable.has(req.clubId);
    const allowed = req.status === "pending_owner" ? isOwner : isClubManager;
    return {
      canApprove: allowed,
      canReject: allowed,
      requiresDoubleConfirm: isOwner && req.overByPercent > OWNER_DOUBLE_CONFIRM_PERCENT,
    };
  }

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
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Показать
        </button>
      </form>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {canManageSelected ? (
          <BudgetLimitForm clubId={selectedClubId} month={month} categories={BUDGET_CATEGORIES} />
        ) : null}
        <RequestForm clubId={selectedClubId} month={month} categories={BUDGET_CATEGORIES} />
      </div>

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

      {/* Requests */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
          Запросы на согласование перерасхода
        </div>
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Клуб</Th>
              <Th>Статья</Th>
              <Th>Месяц</Th>
              <Th>Источник</Th>
              <Th className="text-right">Сумма</Th>
              <Th className="text-right">Перерасход</Th>
              <Th>Статус</Th>
              <Th>Действия</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {requests.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-500">
                  Запросов на согласование пока нет.
                </td>
              </tr>
            ) : (
              requests.map((req) => {
                const flags = decisionFlags(req);
                return (
                  <tr key={req.id} className="hover:bg-slate-50">
                    <Td className="whitespace-nowrap">{req.club.name}</Td>
                    <Td>{budgetCategoryLabel(req.category)}</Td>
                    <Td className="whitespace-nowrap">{req.month}</Td>
                    <Td>{req.sourceType}</Td>
                    <Td className="whitespace-nowrap text-right">{formatKopeks(req.requestedAmountKopeks)}</Td>
                    <Td className="whitespace-nowrap text-right text-rose-700">
                      +{req.overByPercent.toFixed(0)}%
                    </Td>
                    <Td className="whitespace-nowrap">
                      {BUDGET_REQUEST_STATUS_LABELS[req.status] ?? req.status}
                    </Td>
                    <Td>
                      <RequestActions
                        requestId={req.id}
                        canApprove={flags.canApprove}
                        canReject={flags.canReject}
                        requiresDoubleConfirm={flags.requiresDoubleConfirm}
                      />
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
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
