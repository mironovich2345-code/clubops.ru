import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { getPeriodsForScope, periodLabel, periodStatusLabel } from "@/lib/payroll/periods";
import { canManagePayrollAssignments, payrollNavMode } from "@/lib/payroll/access";
import { formatKopeks } from "@/lib/money";
import { CreatePeriodForm } from "../_components/CreatePeriodForm";
import { PayrollNav } from "../_components/PayrollNav";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

// Visually distinct status chips (§5).
const STATUS_META: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  manager_submitted: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  regional_review: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  accounting_review: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  needs_correction: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  regional_approved: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300",
  approved: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  partially_paid: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  paid: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  closed: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};
const REVIEW = new Set(["manager_submitted", "regional_review", "regional_approved", "accounting_review"]);

export default async function PayrollPeriodsPage({ searchParams }: { searchParams: Promise<{ month?: string; club?: string; status?: string; problems?: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return <NoCompanyState title="Расчётные периоды" description="Начисления зарплаты по клубам и месяцам" />;
  }
  const companyId = ctx.selectedCompanyId;
  const sp = await searchParams;
  // Manager works from the single /payroll screen — the periods TABLE is not their flow
  // (§12/§15). Redirect to /payroll preserving month/club (no cyclic redirect: /payroll
  // renders the workspace, never bounces back here).
  if (payrollNavMode(ctx.effectiveRoles) === "manager") {
    const q = new URLSearchParams();
    if (sp.month) q.set("month", sp.month);
    if (sp.club) q.set("club", sp.club);
    redirect(`/payroll${q.toString() ? `?${q.toString()}` : ""}`);
  }
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const clubName = (id: string) => clubs.find((c) => c.id === id)?.name ?? id;
  const monthF = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : null;
  const clubF = sp.club && clubIds.includes(sp.club) ? sp.club : null;
  const statusF = sp.status && (sp.status === "review" || STATUS_META[sp.status]) ? sp.status : null;
  const onlyProblems = sp.problems === "1";

  let periods = await getPeriodsForScope(companyId, clubIds);
  if (monthF) { const [y, m] = monthF.split("-").map(Number); periods = periods.filter((p) => p.year === y && p.month === m); }
  if (clubF) periods = periods.filter((p) => p.clubId === clubF);
  if (statusF) periods = periods.filter((p) => (statusF === "review" ? REVIEW.has(p.status) : p.status === statusF));

  const sums = periods.length
    ? await prisma.payrollCalculation.groupBy({
        by: ["payrollPeriodId"],
        where: { payrollPeriodId: { in: periods.map((p) => p.id) } },
        _sum: { grossAccruedKopeks: true, paidKopeks: true, remainingKopeks: true },
        _count: { _all: true },
      })
    : [];
  const sumBy = new Map(sums.map((s) => [s.payrollPeriodId, { gross: s._sum.grossAccruedKopeks ?? 0, paid: s._sum.paidKopeks ?? 0, remaining: s._sum.remainingKopeks ?? 0, count: s._count._all }]));
  // «Проблем» proxy: calcs still in draft (не рассчитаны) per period.
  const draftAgg = periods.length
    ? await prisma.payrollCalculation.groupBy({ by: ["payrollPeriodId"], where: { payrollPeriodId: { in: periods.map((p) => p.id) }, status: "draft" }, _count: { _all: true } })
    : [];
  const problemsBy = new Map(draftAgg.map((d) => [d.payrollPeriodId, d._count._all]));
  if (onlyProblems) periods = periods.filter((p) => (problemsBy.get(p.id) ?? 0) > 0 || p.status === "needs_correction");

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader title="Зарплата (ФОТ)" description="Расчётные периоды по клубам и месяцам. Один период на клуб и месяц." />
      <PayrollNav mode="full" />

      {canManagePayrollAssignments(ctx.effectiveRoles) && clubs.length > 0 ? (
        <div className={`mb-6 p-5 ${CARD}`}>
          <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Создать период</div>
          <CreatePeriodForm clubs={clubs} />
          <p className="mt-2 text-xs text-slate-400">Если у части сотрудников нет схемы — расчёты создадутся с предупреждением. Проверьте статус настройки в разделе «Сотрудники и схемы» заранее.</p>
        </div>
      ) : null}

      {/* Filters */}
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">Месяц<input type="month" name="month" defaultValue={monthF ?? ""} className="input ml-1 py-1 text-sm" /></label>
        {clubs.length > 1 ? (
          <label className="text-xs text-slate-500">Клуб<select name="club" defaultValue={clubF ?? ""} className="input ml-1 py-1 text-sm"><option value="">все</option>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        ) : null}
        <label className="text-xs text-slate-500">Статус<select name="status" defaultValue={statusF ?? ""} className="input ml-1 py-1 text-sm"><option value="">все</option><option value="draft">Черновик</option><option value="review">На согласовании</option><option value="needs_correction">Возвращён</option><option value="approved">Утверждён</option><option value="partially_paid">Частично выплачен</option><option value="paid">Выплачен</option><option value="closed">Закрыт</option></select></label>
        <label className="flex items-center gap-1 text-xs text-slate-500"><input type="checkbox" name="problems" value="1" defaultChecked={onlyProblems} /> только проблемные</label>
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">Показать</button>
      </form>

      {periods.length === 0 ? (
        <div className={`px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
          Нет расчётных периодов. Создайте первый период выше.
        </div>
      ) : (
        <div className={`overflow-hidden ${CARD}`}>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <Th>Клуб</Th>
                  <Th>Месяц</Th>
                  <Th>Статус</Th>
                  <Th className="text-right">Сотрудников</Th>
                  <Th className="text-right">Начислено</Th>
                  <Th className="text-right">Выплачено</Th>
                  <Th className="text-right">Остаток</Th>
                  <Th className="text-right">Проблем</Th>
                  <Th className="text-right"></Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {periods.map((p) => {
                  const s = sumBy.get(p.id);
                  const problems = problemsBy.get(p.id) ?? 0;
                  return (
                    <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">{clubName(p.clubId)}</Td>
                      <Td className="whitespace-nowrap">{periodLabel(p)}</Td>
                      <Td className="whitespace-nowrap">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_META[p.status] ?? "bg-slate-100 text-slate-600"}`}>
                          {periodStatusLabel(p.status)}
                        </span>
                      </Td>
                      <Td className="text-right">{s?.count ?? 0}</Td>
                      <Td className="text-right tabular-nums">{formatKopeks(s?.gross ?? 0)}</Td>
                      <Td className="text-right tabular-nums">{formatKopeks(s?.paid ?? 0)}</Td>
                      <Td className={`text-right tabular-nums ${(s?.remaining ?? 0) > 0 ? "text-amber-600" : ""}`}>{formatKopeks(s?.remaining ?? 0)}</Td>
                      <Td className="text-right">{problems > 0 ? <span className="text-amber-600">{problems}</span> : <span className="text-slate-300">0</span>}</Td>
                      <Td className="text-right">
                        <Link
                          href={`/payroll/periods/${p.id}`}
                          className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                        >
                          Открыть
                        </Link>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-middle text-sm text-slate-700 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
