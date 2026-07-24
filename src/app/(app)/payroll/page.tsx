import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { getEmployeesForScope } from "@/lib/club-employees";
import { getAssignmentsForEmployees } from "@/lib/payroll/assignments";
import { getSchemesForEmployee, resolveEffectiveScheme, describeSchemeShort } from "@/lib/payroll/schemes";
import { canManagePaySchemes } from "@/lib/payroll/access";
import { PAYROLL_POSITION_LABELS } from "@/lib/payroll/enums";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

export default async function PayrollPage() {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return <NoCompanyState title="Зарплата (ФОТ)" description="Схемы оплаты, начисления и выплаты сотрудникам" />;
  }
  const companyId = ctx.selectedCompanyId;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const showClubColumn = clubs.length > 1;

  const rows = await getEmployeesForScope(companyId, clubIds, { status: "active" });
  const assignments = await getAssignmentsForEmployees(companyId, rows.map((r) => r.id));
  const now = new Date();
  // Effective scheme per employee (employee-specific rows). Cheap for a club roster.
  const schemeByEmployee = new Map<string, string>();
  await Promise.all(
    rows.map(async (r) => {
      const schemes = await getSchemesForEmployee(companyId, r.id);
      const eff = resolveEffectiveScheme(schemes, now);
      if (eff) schemeByEmployee.set(r.id, describeSchemeShort(eff));
    }),
  );

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="mb-4 flex items-center justify-between">
        <PageHeader
          title="Зарплата (ФОТ)"
          description="Схемы оплаты, начисления и выплаты сотрудникам. Настройте закрепления и схемы, затем формируйте расчётные периоды по клубам."
        />
        <div className="flex shrink-0 gap-2">
          <Link
            href="/payroll/summary"
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            Сводка ФОТ
          </Link>
          <Link
            href="/payroll/regional"
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            Регионал
          </Link>
          <Link
            href="/payroll/obligations"
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            Долги
          </Link>
          <Link
            href="/payroll/periods"
            className="inline-flex items-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
          >
            Расчётные периоды →
          </Link>
        </div>
      </div>

      {!canManagePaySchemes(ctx.effectiveRoles) ? (
        <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Схемы оплаты настраивают региональный директор, главный бухгалтер или собственник. Вам доступен просмотр и оформление начислений.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className={`px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
          Нет активных сотрудников. Добавьте их в разделе «Сотрудники».
        </div>
      ) : (
        <div className={`overflow-hidden ${CARD}`}>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <Th>ФИО</Th>
                  {showClubColumn ? <Th>Клуб</Th> : null}
                  <Th>Должность</Th>
                  <Th>Закрепления</Th>
                  <Th>Текущая схема</Th>
                  <Th className="text-right">Настройка</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {rows.map((e) => {
                  const asg = assignments.get(e.id) ?? [];
                  return (
                    <tr key={e.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">{e.fullName}</Td>
                      {showClubColumn ? <Td className="whitespace-nowrap">{e.clubName}</Td> : null}
                      <Td className="whitespace-nowrap">{PAYROLL_POSITION_LABELS[e.position] ?? e.position}</Td>
                      <Td className="text-slate-500 dark:text-slate-400">
                        {asg.length === 0
                          ? "—"
                          : asg.map((a) => PAYROLL_POSITION_LABELS[a.position] ?? a.position).join(", ")}
                      </Td>
                      <Td>
                        {schemeByEmployee.has(e.id) ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                            {schemeByEmployee.get(e.id)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                            Не задана
                          </span>
                        )}
                      </Td>
                      <Td className="text-right">
                        <Link
                          href={`/payroll/employees/${e.id}`}
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
