import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { getPeriodsForScope, periodLabel } from "@/lib/payroll/periods";
import { formatKopeks } from "@/lib/money";
import { PayrollNav } from "../_components/PayrollNav";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const PAYABLE = new Set(["approved", "partially_paid", "paid", "closed"]);

const CALC_STATUS: Record<string, string> = { draft: "Черновик", calculated: "Рассчитан", approved: "Утверждён", paid: "Выплачен", closed: "Закрыт" };

export default async function PayrollPaymentsPage({ searchParams }: { searchParams: Promise<{ month?: string; club?: string; view?: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Выплаты" description="Выплаты зарплаты" />;
  const companyId = ctx.selectedCompanyId;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const clubName = (id: string) => clubs.find((c) => c.id === id)?.name ?? id;
  const now = new Date();
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : monthOf(now);
  const [yStr, mStr] = month.split("-");
  const year = Number(yStr), monthNum = Number(mStr);
  const clubFilter = sp.club && clubIds.includes(sp.club) ? sp.club : null;
  const view = sp.view === "topay" ? "topay" : sp.view === "paid" ? "paid" : "all";

  const periods = (clubIds.length ? await getPeriodsForScope(companyId, clubIds) : [])
    .filter((p) => p.year === year && p.month === monthNum && PAYABLE.has(p.status) && (clubFilter ? p.clubId === clubFilter : true));
  const periodById = new Map(periods.map((p) => [p.id, p]));
  const periodIds = periods.map((p) => p.id);

  const calcs = periodIds.length
    ? await prisma.payrollCalculation.findMany({ where: { payrollPeriodId: { in: periodIds } }, select: { id: true, employeeId: true, payrollPeriodId: true, status: true, grossAccruedKopeks: true, advancesKopeks: true, paidKopeks: true, remainingKopeks: true } })
    : [];
  const empIds = [...new Set(calcs.map((c) => c.employeeId))];
  const nameBy = new Map((empIds.length ? await prisma.clubEmployee.findMany({ where: { id: { in: empIds } }, select: { id: true, fullName: true } }) : []).map((e) => [e.id, e.fullName]));

  // Cards: confirmed payments by method + reversals, and calc buckets.
  const payments = periodIds.length
    ? await prisma.payrollPayment.findMany({ where: { payrollCalculationId: { in: calcs.map((c) => c.id) } }, select: { amountKopeks: true, paymentMethod: true, status: true } })
    : [];
  const cashPaid = payments.filter((p) => p.status === "confirmed" && p.paymentMethod === "cash").reduce((s, p) => s + p.amountKopeks, 0);
  const bankPaid = payments.filter((p) => p.status === "confirmed" && p.paymentMethod === "bank").reduce((s, p) => s + p.amountKopeks, 0);
  const reversals = payments.filter((p) => p.status === "canceled").length;
  const toPay = calcs.filter((c) => c.remainingKopeks > 0).reduce((s, c) => s + c.remainingKopeks, 0);
  const partiallyPaid = calcs.filter((c) => c.paidKopeks > 0 && c.remainingKopeks > 0).length;
  const fullyPaid = calcs.filter((c) => c.remainingKopeks <= 0 && c.paidKopeks > 0).length;

  const rows = calcs
    .filter((c) => (view === "topay" ? c.remainingKopeks > 0 : view === "paid" ? c.remainingKopeks <= 0 && c.paidKopeks > 0 : true))
    .sort((a, b) => b.remainingKopeks - a.remainingKopeks);

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Зарплата (ФОТ)" description="Выплаты — движение денег отдельно от начисления. Сама выплата проводится в карточке расчёта сотрудника." />
      <PayrollNav />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card label="К выплате" value={formatKopeks(toPay)} accent={toPay > 0} />
        <Card label="Частично выплачено" value={String(partiallyPaid)} />
        <Card label="Выплачено (позиций)" value={String(fullyPaid)} />
        <Card label="Наличными" value={formatKopeks(cashPaid)} />
        <Card label="Безналом" value={formatKopeks(bankPaid)} />
        <Card label="Сторно" value={String(reversals)} accent={reversals > 0} />
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">Месяц<input type="month" name="month" defaultValue={month} className="input ml-1 py-1 text-sm" /></label>
        {clubs.length > 1 ? (
          <label className="text-xs text-slate-500">Клуб<select name="club" defaultValue={clubFilter ?? ""} className="input ml-1 py-1 text-sm"><option value="">все</option>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        ) : null}
        <label className="text-xs text-slate-500">Показать<select name="view" defaultValue={view} className="input ml-1 py-1 text-sm"><option value="all">все</option><option value="topay">к выплате</option><option value="paid">выплаченные</option></select></label>
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">Показать</button>
      </form>

      {rows.length === 0 ? (
        <div className={`px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>Нет позиций к выплате за выбранный месяц. Выплаты доступны после утверждения периода.</div>
      ) : (
        <div className={`overflow-hidden ${CARD}`}>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/50"><tr>
                <Th>Сотрудник</Th><Th>Период</Th><Th>Клуб</Th>
                <Th className="text-right">Начислено</Th><Th className="text-right">Авансы</Th><Th className="text-right">Выплачено</Th><Th className="text-right">Остаток</Th>
                <Th>Статус</Th><Th className="text-right">Действие</Th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800/70 dark:bg-slate-900">
                {rows.map((c) => {
                  const p = periodById.get(c.payrollPeriodId)!;
                  return (
                    <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">{nameBy.get(c.employeeId) ?? c.employeeId}</Td>
                      <Td className="whitespace-nowrap">{periodLabel(p)}</Td>
                      <Td className="whitespace-nowrap">{clubName(p.clubId)}</Td>
                      <Td className="text-right tabular-nums">{formatKopeks(c.grossAccruedKopeks)}</Td>
                      <Td className="text-right tabular-nums text-slate-500">{formatKopeks(c.advancesKopeks)}</Td>
                      <Td className="text-right tabular-nums">{formatKopeks(c.paidKopeks)}</Td>
                      <Td className={`text-right tabular-nums ${c.remainingKopeks > 0 ? "text-amber-600" : c.remainingKopeks < 0 ? "text-rose-600" : "text-emerald-600"}`}>{formatKopeks(c.remainingKopeks)}</Td>
                      <Td><span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">{CALC_STATUS[c.status] ?? c.status}</span></Td>
                      <Td className="text-right"><Link href={`/payroll/periods/${p.id}/employees/${c.id}`} className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">{c.remainingKopeks > 0 ? "Выплатить" : "Открыть"}</Link></Td>
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
  return <div className={`p-4 ${CARD}`}><div className="text-xs text-slate-500 dark:text-slate-400">{label}</div><div className={`mt-1 text-lg font-semibold tabular-nums ${accent ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100"}`}>{value}</div></div>;
}
function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-middle text-sm text-slate-700 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
