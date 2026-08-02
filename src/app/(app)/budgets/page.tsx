import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { CompactPageHeader, MobileDataCard, InfoNote, EmptyState } from "@/components/mobile/density";
import { StatusBadge, type StatusTone } from "@/components/mobile/StatusBadge";
import { SegmentedControl, segmentClass, buttonClass } from "@/components/mobile/buttons";
import { MonthField } from "@/components/mobile/DateField";
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
  getBudgetFactReportForScope,
  BUDGET_CATEGORIES,
  budgetCategoryLabel,
  currentMonthKey,
  isValidMonth,
  isBudgetRequestPending,
  BUDGET_REQUEST_STATUS_LABELS,
  type BudgetFactReport,
} from "@/lib/budgets";
import { canManageBudgets, canApproveBudgetOverrunForCategory } from "@/lib/auth";
import { BudgetFactTable } from "@/components/BudgetFactTable";
import { BudgetLimitForm } from "./_components/BudgetForms";
import { BudgetImportPanel } from "./_components/BudgetImportPanel";
import { RequestActions } from "./_components/RequestActions";
import { SalaryBudgetPanel } from "./_components/SalaryBudgetPanel";

export const dynamic = "force-dynamic";

const REQUEST_TABS = [
  { key: "pending", label: "Ожидают" },
  { key: "approved", label: "Согласованы" },
  { key: "rejected", label: "Отклонены" },
] as const;

type RequestTab = (typeof REQUEST_TABS)[number]["key"];

const PAGE_VIEWS = [
  { key: "budgets", label: "Бюджеты" },
  { key: "plan-fact", label: "План / Факт" },
] as const;

type PageView = (typeof PAGE_VIEWS)[number]["key"];

// Budget line status for the mobile cards (spec §15). Business data/order unchanged;
// this is presentational only (desktop table keeps its original order).
type BudgetRow = { hasLimit: boolean; remainingKopeks: number; percentUsed: number | null };
function budgetStatus(row: BudgetRow): { tone: StatusTone; label: string } {
  if (!row.hasLimit) return { tone: "neutral", label: "Лимит не задан" };
  if (row.remainingKopeks < 0) return { tone: "danger", label: "Перерасход" };
  if (row.percentUsed !== null && row.percentUsed >= 80) return { tone: "warning", label: "Близко к лимиту" };
  return { tone: "success", label: "В норме" };
}
function budgetRank(row: BudgetRow): number {
  if (row.hasLimit && row.remainingKopeks < 0) return 0;
  if (row.hasLimit && row.percentUsed !== null && row.percentUsed >= 80) return 1;
  if (!row.hasLimit) return 3;
  return 2;
}

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ clubId?: string; month?: string; tab?: string; view?: string }>;
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
  const view: PageView = PAGE_VIEWS.some((v) => v.key === sp.view)
    ? (sp.view as PageView)
    : "budgets";

  const [overview, requests, manageableClubIds] = await Promise.all([
    getBudgetOverview(selectedClubId, month),
    getBudgetRequestsForScope(scope),
    getManageableClubIds(user.id, scope.company.id),
  ]);
  const manageable = new Set(manageableClubIds);
  // Setting/updating budget limits is owner/GD only (strategic limits). This is
  // distinct from approval rights below, which also include regional directors.
  const canSetLimits = canManageBudgets(ctx.effectiveRoles);
  const effectiveRoles = ctx.effectiveRoles; // captured for closures below

  // Plan vs Fact for the selected club (loaded only when that tab is open).
  const factReport: BudgetFactReport =
    view === "plan-fact"
      ? await getBudgetFactReportForScope(scope.company.id, [selectedClubId], month)
      : [];

  // Approval rights: owner/GD -> all clubs, RD -> assigned clubs (encoded by
  // getManageableClubIds); the requester may never decide their own request.
  // GD may additionally only decide overruns for advertising / salary.
  function canDecide(req: (typeof requests)[number]): boolean {
    return (
      isBudgetRequestPending(req.status) &&
      manageable.has(req.clubId) &&
      req.requestedByUserId !== user.id &&
      canApproveBudgetOverrunForCategory(effectiveRoles, req.category)
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
    const params = new URLSearchParams({ clubId: selectedClubId, month, tab: t, view: "budgets" });
    return `/budgets?${params.toString()}`;
  };
  const viewHref = (v: PageView) => {
    const params = new URLSearchParams({ clubId: selectedClubId, month, view: v });
    return `/budgets?${params.toString()}`;
  };
  const selectedClubName = clubs.find((c) => c.id === selectedClubId)?.name ?? "";

  return (
    <div>
      <CompactPageHeader title="Бюджеты" subtitle="Месячные лимиты по статьям и согласование перерасхода" />

      {/* Club + month selector — full-width stack on mobile, inline row on desktop. */}
      <form method="get" className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 shadow-sm lg:flex lg:flex-wrap lg:items-end lg:gap-3 lg:p-3">
        <label className="block min-w-0 lg:w-56">
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Клуб</span>
          <select name="clubId" defaultValue={selectedClubId} className="input w-full">
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <MonthField label="Месяц" name="month" defaultValue={month} />
        <input type="hidden" name="tab" value={tab} />
        <input type="hidden" name="view" value={view} />
        <button type="submit" className={`${buttonClass({ variant: "primary" })} w-full lg:w-auto`}>
          Показать
        </button>
      </form>

      {/* Page view — shared segmented control (§14) */}
      <div className="mb-4">
        <SegmentedControl>
          {PAGE_VIEWS.map((v) => (
            <Link key={v.key} href={viewHref(v.key)} className={segmentClass(v.key === view)}>{v.label}</Link>
          ))}
        </SegmentedControl>
      </div>

      {view === "budgets" && (
        <div className="mb-4">
          <SalaryBudgetPanel
            companyId={scope.company.id}
            clubIds={clubs.map((c) => c.id)}
            clubNames={Object.fromEntries(clubs.map((c) => [c.id, c.name]))}
            month={month}
            roles={effectiveRoles}
          />
        </div>
      )}

      {view === "plan-fact" ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
            План / Факт · {selectedClubName} · {month}
          </div>
          <BudgetFactTable rows={factReport} />
        </div>
      ) : (
      <>
      {canSetLimits ? (
        <div className="mb-6">
          <BudgetLimitForm clubId={selectedClubId} month={month} categories={BUDGET_CATEGORIES} />
          <BudgetImportPanel month={month} />
        </div>
      ) : (
        <div className="mb-4"><InfoNote>Управлять бюджетами может собственник или ген.директор</InfoNote></div>
      )}

      {/* Overview — desktop table (≥lg) + mobile cards (§15) */}
      <div className="mb-6">
        <div className="mb-2 text-sm font-semibold text-slate-700">Лимиты и использование · {month}</div>
        {/* Desktop table */}
        <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm lg:block">
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
        {/* Mobile cards — overspend first, then close-to-limit (§15). Desktop order preserved. */}
        <div className="space-y-3 lg:hidden">
          {overview.length === 0 ? <EmptyState>Нет статей.</EmptyState> : [...overview].sort((a, b) => budgetRank(a) - budgetRank(b)).map((row) => {
            const s = budgetStatus(row);
            return (
              <MobileDataCard
                key={row.category}
                title={row.label}
                badge={<StatusBadge tone={s.tone}>{s.label}</StatusBadge>}
                rows={[
                  { label: "Лимит", value: row.hasLimit ? formatKopeks(row.limitKopeks) : "—" },
                  { label: "Использовано", value: formatKopeks(row.usedKopeks) },
                  { label: "Остаток", value: row.hasLimit ? formatKopeks(row.remainingKopeks) : "—", strong: true, tone: s.tone === "danger" ? "danger" : undefined },
                  { label: "%", value: row.percentUsed === null ? "—" : `${row.percentUsed.toFixed(0)}%` },
                ]}
              />
            );
          })}
        </div>
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
      </>
      )}
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
