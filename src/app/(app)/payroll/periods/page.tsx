import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { getPeriodsForScope, periodLabel, periodStatusLabel } from "@/lib/payroll/periods";
import { canManagePayrollAssignments } from "@/lib/payroll/access";
import { formatKopeks } from "@/lib/money";
import { CreatePeriodForm } from "../_components/CreatePeriodForm";
import { PayrollNav } from "../_components/PayrollNav";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

export default async function PayrollPeriodsPage() {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return <NoCompanyState title="Расчётные периоды" description="Начисления зарплаты по клубам и месяцам" />;
  }
  const companyId = ctx.selectedCompanyId;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const clubName = (id: string) => clubs.find((c) => c.id === id)?.name ?? id;

  const periods = await getPeriodsForScope(companyId, clubIds);
  const sums = periods.length
    ? await prisma.payrollCalculation.groupBy({
        by: ["payrollPeriodId"],
        where: { payrollPeriodId: { in: periods.map((p) => p.id) } },
        _sum: { grossAccruedKopeks: true },
        _count: { _all: true },
      })
    : [];
  const sumBy = new Map(sums.map((s) => [s.payrollPeriodId, { gross: s._sum.grossAccruedKopeks ?? 0, count: s._count._all }]));

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader title="Зарплата (ФОТ)" description="Расчётные периоды по клубам и месяцам. Один период на клуб и месяц." />
      <PayrollNav />

      {canManagePayrollAssignments(ctx.effectiveRoles) && clubs.length > 0 ? (
        <div className={`mb-6 p-5 ${CARD}`}>
          <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Создать период</div>
          <CreatePeriodForm clubs={clubs} />
        </div>
      ) : null}

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
                  <Th className="text-right"></Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {periods.map((p) => {
                  const s = sumBy.get(p.id);
                  return (
                    <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">{clubName(p.clubId)}</Td>
                      <Td className="whitespace-nowrap">{periodLabel(p)}</Td>
                      <Td className="whitespace-nowrap">
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          {periodStatusLabel(p.status)}
                        </span>
                      </Td>
                      <Td className="text-right">{s?.count ?? 0}</Td>
                      <Td className="text-right tabular-nums">{formatKopeks(s?.gross ?? 0)}</Td>
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
