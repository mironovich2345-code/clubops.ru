import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { canReviewPayrollChange } from "@/lib/payroll/access";
import { STATUS_LABEL, REQUEST_TYPE_LABEL, FIELD_TYPE_LABEL, OPEN_BLOCKING_STATUSES } from "@/lib/payroll/change-request";
import { PayrollNav } from "../_components/PayrollNav";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const toneCls: Record<string, string> = {
  amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  sky: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  emerald: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  rose: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  slate: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};

function Badge({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ?? { label: status, tone: "slate" as const };
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${toneCls[s.tone]}`}>{s.label}</span>;
}

function Impact({ kopeks, uncomputable }: { kopeks: number | null; uncomputable: boolean }) {
  if (uncomputable) return <span className="text-amber-600">не рассчитано</span>;
  if (kopeks == null) return <span className="text-slate-400">—</span>;
  return <span className={kopeks >= 0 ? "text-emerald-600" : "text-rose-600"}>{kopeks >= 0 ? "+" : "−"}{formatKopeks(Math.abs(kopeks))}</span>;
}

export default async function PayrollChangeRequestsPage({ searchParams }: { searchParams: Promise<{ status?: string; club?: string; type?: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Согласования зарплаты" description="Заявки на изменение параметров зарплаты" />;
  const companyId = ctx.selectedCompanyId;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const clubName = (id: string) => clubs.find((c) => c.id === id)?.name ?? id;

  const sp = await searchParams;
  const statusFilter = sp.status && STATUS_LABEL[sp.status] ? sp.status : null;
  const clubFilter = sp.club && clubIds.includes(sp.club) ? sp.club : null;
  const typeFilter = sp.type === "period_adjustment" || sp.type === "future_scheme_change" ? sp.type : null;
  const canReview = canReviewPayrollChange(ctx.effectiveRoles);

  const requests = clubIds.length
    ? await prisma.payrollChangeRequest.findMany({
        where: {
          companyId,
          clubId: clubFilter ? clubFilter : { in: clubIds },
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(typeFilter ? { requestType: typeFilter } : {}),
        },
        orderBy: [{ createdAt: "desc" }],
        take: 200,
      })
    : [];

  // KPI cards over the in-scope set (independent of the active filter).
  const all = clubIds.length ? await prisma.payrollChangeRequest.findMany({ where: { companyId, clubId: { in: clubIds } }, select: { status: true } }) : [];
  const kpi = {
    open: all.filter((r) => OPEN_BLOCKING_STATUSES.has(r.status)).length,
    returned: all.filter((r) => r.status === "returned_for_revision").length,
    applied: all.filter((r) => r.status === "applied" || r.status === "approved_pending_scheme_creation").length,
    rejected: all.filter((r) => r.status === "rejected").length,
  };

  const empIds = [...new Set(requests.map((r) => r.employeeId).filter((x): x is string => !!x))];
  const empRows = empIds.length ? await prisma.clubEmployee.findMany({ where: { id: { in: empIds } }, select: { id: true, fullName: true } }) : [];
  const nameBy = new Map(empRows.map((e) => [e.id, e.fullName]));

  const qs = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const merged = { status: statusFilter, club: clubFilter, type: typeFilter, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    const s = params.toString();
    return s ? `?${s}` : "";
  };

  return (
    <div>
      <PageHeader title="Согласования зарплаты" description="Заявки регионала на изменение закрытых параметров — решение ГД/собственника" />
      <PayrollNav />

      {/* KPI */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="На согласовании" value={kpi.open} accent />
        <Kpi label="На доработке" value={kpi.returned} />
        <Kpi label="Применено" value={kpi.applied} />
        <Kpi label="Отклонено" value={kpi.rejected} />
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <FilterLink href={qs({ status: null })} active={!statusFilter}>Все статусы</FilterLink>
        {["submitted", "returned_for_revision", "applied", "rejected"].map((s) => (
          <FilterLink key={s} href={qs({ status: s })} active={statusFilter === s}>{STATUS_LABEL[s]?.label ?? s}</FilterLink>
        ))}
        <span className="mx-1 text-slate-300">·</span>
        <FilterLink href={qs({ type: null })} active={!typeFilter}>Все типы</FilterLink>
        <FilterLink href={qs({ type: "period_adjustment" })} active={typeFilter === "period_adjustment"}>Разовые</FilterLink>
        <FilterLink href={qs({ type: "future_scheme_change" })} active={typeFilter === "future_scheme_change"}>Будущая схема</FilterLink>
        {clubs.length > 1 ? (
          <>
            <span className="mx-1 text-slate-300">·</span>
            <FilterLink href={qs({ club: null })} active={!clubFilter}>Все клубы</FilterLink>
            {clubs.map((c) => (
              <FilterLink key={c.id} href={qs({ club: c.id })} active={clubFilter === c.id}>{c.name}</FilterLink>
            ))}
          </>
        ) : null}
      </div>

      {requests.length === 0 ? (
        <div className={`p-8 text-center text-sm text-slate-400 ${CARD}`}>Заявок нет.</div>
      ) : (
        <>
          {/* Desktop table */}
          <div className={`hidden overflow-hidden sm:block ${CARD}`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/60">
                  <tr>
                    <th className="px-4 py-2 font-medium">Сотрудник</th>
                    <th className="px-4 py-2 font-medium">Клуб</th>
                    <th className="px-4 py-2 font-medium">Изменение</th>
                    <th className="px-4 py-2 font-medium">Влияние</th>
                    <th className="px-4 py-2 font-medium">Статус</th>
                    <th className="px-4 py-2 font-medium">Создано</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2 text-slate-800 dark:text-slate-200">{r.employeeId ? nameBy.get(r.employeeId) ?? "—" : "—"}</td>
                      <td className="px-4 py-2 text-slate-500">{clubName(r.clubId)}</td>
                      <td className="px-4 py-2 text-slate-600 dark:text-slate-300">
                        {FIELD_TYPE_LABEL[r.fieldType] ?? r.fieldType}
                        <div className="text-[11px] text-slate-400">{REQUEST_TYPE_LABEL[r.requestType] ?? r.requestType}{r.revision > 1 ? ` · ред. ${r.revision}` : ""}</div>
                      </td>
                      <td className="px-4 py-2 tabular-nums"><Impact kopeks={r.calculatedImpactKopeks} uncomputable={r.impactUncomputable} /></td>
                      <td className="px-4 py-2"><Badge status={r.status} /></td>
                      <td className="px-4 py-2 text-xs text-slate-400">{dateFmt.format(r.createdAt)}</td>
                      <td className="px-4 py-2 text-right"><Link href={`/payroll/change-requests/${r.id}`} className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">{canReview && OPEN_BLOCKING_STATUSES.has(r.status) ? "Рассмотреть" : "Открыть"}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-3 sm:hidden">
            {requests.map((r) => (
              <li key={r.id} className={`p-4 ${CARD}`}>
                <div className="mb-1 flex items-start justify-between gap-2">
                  <div className="font-medium text-slate-800 dark:text-slate-200">{r.employeeId ? nameBy.get(r.employeeId) ?? "—" : "—"}</div>
                  <Badge status={r.status} />
                </div>
                <div className="text-xs text-slate-500">{clubName(r.clubId)} · {dateFmt.format(r.createdAt)}</div>
                <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">{FIELD_TYPE_LABEL[r.fieldType] ?? r.fieldType} · {REQUEST_TYPE_LABEL[r.requestType] ?? r.requestType}</div>
                <div className="mt-1 text-sm tabular-nums">Влияние: <Impact kopeks={r.calculatedImpactKopeks} uncomputable={r.impactUncomputable} /></div>
                <Link href={`/payroll/change-requests/${r.id}`} className="mt-2 inline-flex text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">{canReview && OPEN_BLOCKING_STATUSES.has(r.status) ? "Рассмотреть →" : "Открыть →"}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`p-4 ${CARD}`}>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${accent && value > 0 ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100"}`}>{value}</div>
    </div>
  );
}

function FilterLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={`/payroll/change-requests${href}`} className={`rounded-full px-3 py-1 font-medium transition-colors ${active ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"}`}>
      {children}
    </Link>
  );
}
