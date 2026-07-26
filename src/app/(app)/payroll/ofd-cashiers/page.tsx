import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { canManageCashierMapping, payrollNavMode } from "@/lib/payroll/access";
import { PayrollNav } from "../_components/PayrollNav";
import { CashierSyncButton } from "../_components/CashierSyncButton";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const STATUS_TONE: Record<string, string> = {
  confirmed: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  manually_assigned: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  auto_matched: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  ambiguous: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  unmatched: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  excluded: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};
const STATUS_LABEL: Record<string, string> = {
  confirmed: "Подтверждён", manually_assigned: "Назначен вручную", auto_matched: "Авто-совпадение",
  ambiguous: "Спорный", unmatched: "Не сопоставлен", excluded: "Исключён", inactive: "Неактивен",
};

export default async function OfdCashiersPage({ searchParams }: { searchParams: Promise<{ club?: string; status?: string; withSales?: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Кассиры ОФД" description="Сопоставление кассиров с сотрудниками" />;
  if (payrollNavMode(ctx.effectiveRoles) === "manager") redirect("/payroll");
  const companyId = ctx.selectedCompanyId;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const clubName = (id: string | null) => (id ? clubs.find((c) => c.id === id)?.name ?? id : "—");
  const sp = await searchParams;
  const clubFilter = sp.club && clubIds.includes(sp.club) ? sp.club : null;
  const canManage = canManageCashierMapping(ctx.effectiveRoles);

  const identities = clubIds.length
    ? await prisma.ofdCashierIdentity.findMany({ where: { companyId, OR: [{ clubId: clubFilter ? clubFilter : { in: clubIds } }, { clubId: null }] }, orderBy: [{ lastSeenAt: "desc" }], take: 300 })
    : [];
  const idIds = identities.map((i) => i.id);
  const mappings = idIds.length ? await prisma.ofdCashierMapping.findMany({ where: { cashierIdentityId: { in: idIds }, effectiveTo: null }, orderBy: { effectiveFrom: "desc" } }) : [];
  const mapBy = new Map<string, (typeof mappings)[number]>();
  for (const m of mappings) if (!mapBy.has(m.cashierIdentityId)) mapBy.set(m.cashierIdentityId, m);
  const empIds = [...new Set(mappings.map((m) => m.employeeId).filter((x): x is string => !!x))];
  const emps = empIds.length ? await prisma.clubEmployee.findMany({ where: { id: { in: empIds } }, select: { id: true, fullName: true } }) : [];
  const nameBy = new Map(emps.map((e) => [e.id, e.fullName]));

  const statusOf = (id: string) => mapBy.get(id)?.status ?? "unmatched";
  let rows = identities.map((i) => ({ i, m: mapBy.get(i.id), status: i.status === "excluded" ? "excluded" : statusOf(i.id) }));
  if (sp.status) rows = rows.filter((r) => r.status === sp.status);
  if (sp.withSales === "1") rows = rows.filter((r) => r.i.salesAmountKopeks > 0);

  // KPI over the in-scope set.
  const kpiSrc = identities.map((i) => (i.status === "excluded" ? "excluded" : statusOf(i.id)));
  const kpi = {
    total: identities.length,
    confirmed: kpiSrc.filter((s) => s === "confirmed" || s === "manually_assigned").length,
    auto: kpiSrc.filter((s) => s === "auto_matched").length,
    unmatched: kpiSrc.filter((s) => s === "unmatched").length,
    ambiguous: kpiSrc.filter((s) => s === "ambiguous").length,
    excluded: kpiSrc.filter((s) => s === "excluded").length,
  };
  const unattributedKopeks = identities.filter((i) => { const s = i.status === "excluded" ? "excluded" : statusOf(i.id); return s !== "confirmed" && s !== "manually_assigned"; }).reduce((s, i) => s + i.salesAmountKopeks, 0);

  const qs = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | null> = { club: clubFilter, status: sp.status ?? null, withSales: sp.withSales ?? null, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    const s = params.toString();
    return `/payroll/ofd-cashiers${s ? `?${s}` : ""}`;
  };

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader title="Кассиры ОФД" description="Сопоставление кассиров из чеков с сотрудниками для личной выручки." />
      <PayrollNav mode="full" />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Всего" value={kpi.total} />
        <Kpi label="Подтверждено" value={kpi.confirmed} />
        <Kpi label="Авто" value={kpi.auto} />
        <Kpi label="Спорных" value={kpi.ambiguous} accent={kpi.ambiguous > 0} />
        <Kpi label="Без сопоставления" value={kpi.unmatched} accent={kpi.unmatched > 0} />
        <Kpi label="Выручка без атрибуции" value={formatKopeks(unattributedKopeks)} accent={unattributedKopeks > 0} wide />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        {canManage ? <CashierSyncButton club={clubFilter ?? undefined} /> : null}
        <span className="mx-1 text-slate-300">·</span>
        <FilterLink href={qs({ status: null })} active={!sp.status}>Все</FilterLink>
        {["unmatched", "ambiguous", "auto_matched", "confirmed", "excluded"].map((s) => (
          <FilterLink key={s} href={qs({ status: s })} active={sp.status === s}>{STATUS_LABEL[s]}</FilterLink>
        ))}
        {clubs.length > 1 ? (
          <>
            <span className="mx-1 text-slate-300">·</span>
            <FilterLink href={qs({ club: null })} active={!clubFilter}>Все клубы</FilterLink>
            {clubs.map((c) => <FilterLink key={c.id} href={qs({ club: c.id })} active={clubFilter === c.id}>{c.name}</FilterLink>)}
          </>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className={`px-4 py-10 text-center text-sm text-slate-500 ${CARD}`}>Кассиров нет. {canManage ? "Нажмите «Обновить из чеков» — идентификаторы строятся из чеков ОФД, содержащих кассира." : ""}</div>
      ) : (
        <>
          <div className={`hidden overflow-hidden sm:block ${CARD}`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/60">
                  <tr><th className="px-4 py-2 font-medium">Кассир (ОФД)</th><th className="px-4 py-2 font-medium">Клуб</th><th className="px-4 py-2 font-medium">Сотрудник</th><th className="px-4 py-2 font-medium">Чеков</th><th className="px-4 py-2 font-medium">Продажи</th><th className="px-4 py-2 font-medium">Статус</th><th className="px-4 py-2" /></tr>
                </thead>
                <tbody>
                  {rows.map(({ i, m, status }) => (
                    <tr key={i.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-2 text-slate-800 dark:text-slate-200">{i.rawName}<div className="text-[11px] text-slate-400">{i.provider} · до {dateFmt.format(i.lastSeenAt)}</div></td>
                      <td className="px-4 py-2 text-slate-500">{clubName(i.clubId)}</td>
                      <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{m?.employeeId ? nameBy.get(m.employeeId) ?? "—" : "—"}</td>
                      <td className="px-4 py-2 tabular-nums">{i.receiptsCount}</td>
                      <td className="px-4 py-2 tabular-nums">{formatKopeks(i.salesAmountKopeks)}</td>
                      <td className="px-4 py-2"><Badge status={status} /></td>
                      <td className="px-4 py-2 text-right"><Link href={`/payroll/ofd-cashiers/${i.id}`} className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">Открыть →</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <ul className="space-y-3 sm:hidden">
            {rows.map(({ i, m, status }) => (
              <li key={i.id} className={`p-4 ${CARD}`}>
                <div className="mb-1 flex items-start justify-between gap-2"><div className="font-medium text-slate-800 dark:text-slate-200 break-words">{i.rawName}</div><Badge status={status} /></div>
                <div className="text-xs text-slate-500">{clubName(i.clubId)} · {i.provider} · {i.receiptsCount} чек.</div>
                <div className="mt-1 text-sm tabular-nums">Продажи: {formatKopeks(i.salesAmountKopeks)}</div>
                <div className="text-xs text-slate-500">Сотрудник: {m?.employeeId ? nameBy.get(m.employeeId) ?? "—" : "—"}</div>
                <Link href={`/payroll/ofd-cashiers/${i.id}`} className="mt-2 inline-flex text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">Открыть →</Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, accent, wide }: { label: string; value: number | string; accent?: boolean; wide?: boolean }) {
  return (
    <div className={`p-4 ${CARD} ${wide ? "col-span-2 sm:col-span-1" : ""}`}>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${accent && Number(value) !== 0 ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100"}`}>{value}</div>
    </div>
  );
}
function Badge({ status }: { status: string }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status] ?? STATUS_TONE.unmatched}`}>{STATUS_LABEL[status] ?? status}</span>;
}
function FilterLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return <Link href={href} className={`rounded-full px-3 py-1 font-medium transition-colors ${active ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"}`}>{children}</Link>;
}
