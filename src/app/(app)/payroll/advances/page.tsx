import Link from "next/link";
import { buttonClass } from "@/components/mobile/buttons";
import { MonthField } from "@/components/mobile/DateField";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { getEmployeesForScope } from "@/lib/club-employees";
import { canManagePayrollAssignments, payrollNavMode } from "@/lib/payroll/access";
import { PAYROLL_POSITION_LABELS } from "@/lib/payroll/enums";
import { formatKopeks } from "@/lib/money";
import { PayrollNav } from "../_components/PayrollNav";
import { AdvanceCreateForm, type AdvanceEmployeeOption } from "../_components/AdvanceCreateForm";
import { approveEmployeeAdvance, cancelEmployeeAdvance } from "../advance-actions";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

// User-facing status labels (§12) mapped from technical statuses.
const STATUS_UI: Record<string, { label: string; cls: string }> = {
  requested: { label: "Ожидает подтверждения", cls: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" },
  approved: { label: "Согласован", cls: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300" },
  paid: { label: "Выплачен", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" },
  rejected: { label: "Отклонён", cls: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300" },
  canceled: { label: "Отменён", cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" },
};

export default async function PayrollAdvancesPage({ searchParams }: { searchParams: Promise<{ month?: string; club?: string; status?: string; needs?: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Авансы" description="Авансы сотрудникам" />;
  const companyId = ctx.selectedCompanyId;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const now = new Date();
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : monthOf(now);
  const [yStr, mStr] = month.split("-");
  const year = Number(yStr), monthNum = Number(mStr);
  const clubFilter = sp.club && clubIds.includes(sp.club) ? sp.club : null;
  const statusFilter = sp.status && STATUS_UI[sp.status] ? sp.status : null;
  const onlyNeeds = sp.needs === "1";

  const canManage = canManagePayrollAssignments(ctx.effectiveRoles);
  const canApprove = ctx.effectiveRoles.includes("regional_director");

  const roster = clubIds.length ? await getEmployeesForScope(companyId, clubIds, { status: "active" }) : [];
  const employeeOptions: AdvanceEmployeeOption[] = roster.map((e) => ({ id: e.id, fullName: e.fullName, clubId: e.clubId, clubName: e.clubName, position: e.position }));

  const advances = clubIds.length
    ? await prisma.payrollAdvance.findMany({
        where: {
          companyId,
          clubId: clubFilter ? clubFilter : { in: clubIds },
          periodYear: year,
          periodMonth: monthNum,
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(onlyNeeds ? { status: "requested" } : {}),
        },
        orderBy: [{ requestedAt: "desc" }],
      })
    : [];

  // Resolve names/positions (advances may reference dismissed employees not in the roster).
  const empIds = [...new Set(advances.map((a) => a.employeeId))];
  const empRows = empIds.length ? await prisma.clubEmployee.findMany({ where: { id: { in: empIds } }, select: { id: true, fullName: true, position: true } }) : [];
  const nameBy = new Map(empRows.map((e) => [e.id, e.fullName]));
  const posBy = new Map(empRows.map((e) => [e.id, e.position]));
  const clubName = (id: string) => clubs.find((c) => c.id === id)?.name ?? id;

  // Cards (§9): buckets for the selected month (before status filter is applied to the table).
  const monthAll = clubIds.length
    ? await prisma.payrollAdvance.findMany({ where: { companyId, clubId: clubFilter ? clubFilter : { in: clubIds }, periodYear: year, periodMonth: monthNum }, select: { status: true, amountKopeks: true } })
    : [];
  const bucket = (st: string) => monthAll.filter((a) => a.status === st);
  const sumOf = (st: string) => bucket(st).reduce((s, a) => s + a.amountKopeks, 0);
  const toPaySum = monthAll.filter((a) => a.status === "requested" || a.status === "approved").reduce((s, a) => s + a.amountKopeks, 0);

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Зарплата (ФОТ)" description="Авансы. Можно создавать до расчётного периода — они привяжутся к расчёту автоматически." />
      <PayrollNav mode={payrollNavMode(ctx.effectiveRoles)} />

      <div className="mb-4">
        <AdvanceCreateForm employees={employeeOptions} defaultMonth={month} canManage={canManage} />
      </div>

      {/* Cards */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card label="Ожидают подтверждения" value={String(bucket("requested").length)} accent={bucket("requested").length > 0} />
        <Card label="Согласовано" value={String(bucket("approved").length)} />
        <Card label="Выплачено" value={String(bucket("paid").length)} />
        <Card label="Отклонено" value={String(bucket("rejected").length)} />
        <Card label="К выплате, сумма" value={formatKopeks(toPaySum)} />
        <Card label="Выплачено за месяц" value={formatKopeks(sumOf("paid"))} />
      </div>

      {/* Filters — mobile stack (2-col), desktop inline. Checkbox + button own rows. */}
      <form method="get" className="mb-4 grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:flex lg:flex-wrap lg:items-end">
        <MonthField label="Месяц" name="month" defaultValue={month} />
        {clubs.length > 1 ? (
          <label className="block min-w-0"><span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Клуб</span>
            <select name="club" defaultValue={clubFilter ?? ""} className="input w-full"><option value="">все</option>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        ) : null}
        <label className="block min-w-0"><span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Статус</span>
          <select name="status" defaultValue={statusFilter ?? ""} className="input w-full"><option value="">все</option>{Object.entries(STATUS_UI).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-[var(--text-secondary)] min-[380px]:col-span-2 lg:min-h-0 lg:pb-2"><input type="checkbox" name="needs" value="1" defaultChecked={onlyNeeds} className="h-4 w-4" /> только требующие решения</label>
        <button type="submit" className={`${buttonClass({ variant: "primary" })} w-full min-[380px]:col-span-2 lg:col-span-1 lg:w-auto`}>Показать</button>
      </form>

      {/* Mobile cards (§19 — no horizontal table on narrow screens) */}
      {advances.length > 0 ? (
        <ul className="space-y-2 md:hidden">
          {advances.map((a) => {
            const ui = STATUS_UI[a.status] ?? { label: a.status, cls: "bg-slate-100 text-slate-500" };
            return (
              <li key={a.id} className={`p-3 ${CARD}`}>
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{nameBy.get(a.employeeId) ?? a.employeeId}</span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${ui.cls}`}>{ui.label}</span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{clubName(a.clubId)} · {PAYROLL_POSITION_LABELS[posBy.get(a.employeeId) ?? ""] ?? "—"}</div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div><div className="text-slate-400">Запрошено</div><div className="font-medium tabular-nums">{formatKopeks(a.amountKopeks)}</div></div>
                  <div><div className="text-slate-400">Заработано</div><div className="font-medium tabular-nums">{formatKopeks(a.earnedToDateKopeks)}</div></div>
                  <div><div className="text-slate-400">Способ</div><div className="font-medium">{a.paymentMethod === "bank" ? "безнал" : "наличные"}</div></div>
                </div>
                <div className="mt-2"><Link href={`/payroll/advances/${a.id}`} className="inline-flex min-h-[40px] items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">Открыть · транши</Link></div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Table (desktop) */}
      {advances.length === 0 ? (
        <div className={`px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>Авансов за выбранный период нет.</div>
      ) : (
        <div className={`hidden overflow-hidden md:block ${CARD}`}>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/50"><tr>
                <Th>Сотрудник</Th><Th>Клуб</Th><Th>Должность</Th><Th>Дата</Th>
                <Th className="text-right">Запрошено</Th><Th className="text-right">Заработано</Th><Th className="text-right">Выплачено</Th>
                <Th>Способ</Th><Th>Статус</Th><Th className="text-right">Действие</Th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {advances.map((a) => {
                  const ui = STATUS_UI[a.status] ?? { label: a.status, cls: "bg-slate-100 text-slate-500" };
                  return (
                    <tr key={a.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">{nameBy.get(a.employeeId) ?? a.employeeId}</Td>
                      <Td className="whitespace-nowrap">{clubName(a.clubId)}</Td>
                      <Td className="whitespace-nowrap">{PAYROLL_POSITION_LABELS[posBy.get(a.employeeId) ?? ""] ?? "—"}</Td>
                      <Td className="whitespace-nowrap text-slate-500">{a.requestedAt ? dateFmt.format(a.requestedAt) : "—"}</Td>
                      <Td className="text-right tabular-nums">{formatKopeks(a.amountKopeks)}</Td>
                      <Td className="text-right tabular-nums text-slate-500">{formatKopeks(a.earnedToDateKopeks)}{a.earnedToDateSource === "manual" ? <span className="ml-1 text-[10px] text-amber-600">ручн.</span> : null}</Td>
                      <Td className="text-right tabular-nums">{a.status === "paid" ? formatKopeks(a.amountKopeks) : "—"}</Td>
                      <Td className="whitespace-nowrap">{a.paymentMethod === "bank" ? "безнал" : "наличные"}</Td>
                      <Td><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${ui.cls}`}>{ui.label}</span></Td>
                      <Td className="text-right">
                        <div className="flex justify-end gap-2">
                          <Link href={`/payroll/advances/${a.id}`} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">Открыть · транши</Link>
                          {canApprove && a.status === "requested" ? (
                            <form action={approveEmployeeAdvance}><input type="hidden" name="advanceId" value={a.id} /><button type="submit" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">Подтвердить и выдать</button></form>
                          ) : null}
                          {canManage && ["requested", "approved", "paid"].includes(a.status) ? (
                            <form action={cancelEmployeeAdvance}><input type="hidden" name="advanceId" value={a.id} /><button type="submit" className="text-slate-400 hover:text-rose-600" title="Отменить/сторнировать">✕</button></form>
                          ) : null}
                        </div>
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

function Card({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`p-4 ${CARD}`}>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${accent ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100"}`}>{value}</div>
    </div>
  );
}
function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-middle text-sm text-slate-700 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
