import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { PayrollNav } from "../_components/PayrollNav";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

export default async function PayrollSummaryPage() {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return <NoCompanyState title="Сводка по ФОТ" description="Общий фонд оплаты труда по клубам" />;
  }
  const companyId = ctx.selectedCompanyId;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const clubName = (id: string) => clubs.find((c) => c.id === id)?.name ?? id;

  const [byClub, oblByDirection] = await Promise.all([
    clubIds.length
      ? prisma.payrollCalculation.groupBy({
          by: ["clubId"],
          where: { companyId, clubId: { in: clubIds } },
          _sum: { grossAccruedKopeks: true, paidKopeks: true, remainingKopeks: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    clubIds.length
      ? prisma.employeeFinancialObligation.groupBy({
          by: ["direction"],
          where: { companyId, clubId: { in: clubIds }, status: { in: ["open", "partially_settled"] } },
          _sum: { outstandingAmountKopeks: true },
        })
      : Promise.resolve([]),
  ]);

  const totals = byClub.reduce(
    (t, r) => ({
      accrued: t.accrued + (r._sum.grossAccruedKopeks ?? 0),
      paid: t.paid + (r._sum.paidKopeks ?? 0),
      remaining: t.remaining + (r._sum.remainingKopeks ?? 0),
    }),
    { accrued: 0, paid: 0, remaining: 0 },
  );
  const employeeOwes = oblByDirection.find((o) => o.direction === "employee_owes_company")?._sum.outstandingAmountKopeks ?? 0;
  const companyOwes = oblByDirection.find((o) => o.direction === "company_owes_employee")?._sum.outstandingAmountKopeks ?? 0;

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Зарплата (ФОТ)" description="Сводка ФОТ по клубам за всё время (начислено / выплачено / остаток) и открытые взаимные долги." />
      <PayrollNav />

      <div className={`mb-6 grid grid-cols-2 gap-4 p-5 sm:grid-cols-3 ${CARD}`}>
        <Stat label="Начислено (всего)" value={formatKopeks(totals.accrued)} />
        <Stat label="Выплачено" value={formatKopeks(totals.paid)} />
        <Stat label="Остаток к выплате" value={formatKopeks(totals.remaining)} accent={totals.remaining > 0} />
      </div>

      <div className={`mb-6 grid grid-cols-2 gap-4 p-5 ${CARD}`}>
        <Stat label="Сотрудники должны компании" value={formatKopeks(employeeOwes)} tone="rose" />
        <Stat label="Компания должна сотрудникам" value={formatKopeks(companyOwes)} tone="emerald" />
      </div>

      {byClub.length === 0 ? (
        <div className={`px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
          Пока нет расчётов.
        </div>
      ) : (
        <div className={`overflow-hidden ${CARD}`}>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <Th>Клуб</Th>
                  <Th className="text-right">Позиций</Th>
                  <Th className="text-right">Начислено</Th>
                  <Th className="text-right">Выплачено</Th>
                  <Th className="text-right">Остаток</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {byClub.map((r) => (
                  <tr key={r.clubId} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">{clubName(r.clubId)}</Td>
                    <Td className="text-right">{r._count._all}</Td>
                    <Td className="text-right tabular-nums">{formatKopeks(r._sum.grossAccruedKopeks ?? 0)}</Td>
                    <Td className="text-right tabular-nums">{formatKopeks(r._sum.paidKopeks ?? 0)}</Td>
                    <Td className="text-right tabular-nums">{formatKopeks(r._sum.remainingKopeks ?? 0)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent, tone }: { label: string; value: string; accent?: boolean; tone?: "rose" | "emerald" }) {
  const color = tone === "rose" ? "text-rose-600 dark:text-rose-400" : tone === "emerald" ? "text-emerald-600 dark:text-emerald-400" : accent ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100";
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-middle text-sm text-slate-700 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
