import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import {
  getOpenObligationsForScope,
  canSettleObligation,
  canWriteOffObligation,
  OBLIGATION_DIRECTION_LABELS,
} from "@/lib/payroll/obligations";
import { canManagePayrollAssignments, payrollNavMode } from "@/lib/payroll/access";
import { formatKopeks } from "@/lib/money";
import { ObligationRow } from "../_components/ObligationRow";
import { PayrollNav } from "../_components/PayrollNav";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

export default async function PayrollObligationsPage() {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return <NoCompanyState title="Долги и обязательства" description="Взаимные долги сотрудников и компании" />;
  }
  const companyId = ctx.selectedCompanyId;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const clubName = (id: string | null) => (id ? clubs.find((c) => c.id === id)?.name ?? id : "—");

  const obligations = await getOpenObligationsForScope(companyId, clubIds);
  const employees = obligations.length
    ? await prisma.clubEmployee.findMany({ where: { id: { in: obligations.map((o) => o.employeeId) } }, select: { id: true, fullName: true } })
    : [];
  const nameBy = new Map(employees.map((e) => [e.id, e.fullName]));

  const canSettle = canSettleObligation(ctx.effectiveRoles);
  const canWriteOff = canWriteOffObligation(ctx.effectiveRoles);
  const canCash = canManagePayrollAssignments(ctx.effectiveRoles);
  const canBank = ctx.effectiveRoles.some((r) => r === "accountant" || r === "chief_accountant");

  const employeeOwes = obligations.filter((o) => o.direction === "employee_owes_company");
  const companyOwes = obligations.filter((o) => o.direction === "company_owes_employee");
  const totalEmployeeOwes = employeeOwes.reduce((s, o) => s + o.outstandingAmountKopeks, 0);
  const totalCompanyOwes = companyOwes.reduce((s, o) => s + o.outstandingAmountKopeks, 0);

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Зарплата (ФОТ)" description="Долги и обязательства. Погашение всегда закрывает конкретное обязательство." />
      <PayrollNav mode={payrollNavMode(ctx.effectiveRoles)} />

      <div className={`mb-6 grid grid-cols-2 gap-4 p-5 ${CARD}`}>
        <div>
          <div className="text-xs text-slate-500 dark:text-slate-400">Сотрудники должны компании</div>
          <div className="text-lg font-semibold tabular-nums text-rose-600 dark:text-rose-400">{formatKopeks(totalEmployeeOwes)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500 dark:text-slate-400">Компания должна сотрудникам</div>
          <div className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{formatKopeks(totalCompanyOwes)}</div>
        </div>
      </div>

      {obligations.length === 0 ? (
        <div className={`px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
          Нет открытых обязательств.
        </div>
      ) : (
        <div className={`divide-y divide-slate-100 dark:divide-slate-800/70 ${CARD}`}>
          {obligations.map((o) => (
            <div key={o.id} className="p-4">
              <div className="mb-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                {nameBy.get(o.employeeId) ?? o.employeeId}
                <span className="ml-2 text-xs font-normal text-slate-400">{clubName(o.clubId)} · {o.reason}</span>
              </div>
              <ObligationRow
                obligationId={o.id}
                directionLabel={OBLIGATION_DIRECTION_LABELS[o.direction] ?? o.direction}
                isEmployeeDebt={o.direction === "employee_owes_company"}
                outstandingKopeks={o.outstandingAmountKopeks}
                canSettle={canSettle}
                canWriteOff={canWriteOff}
                canCash={canCash}
                canBank={canBank}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
