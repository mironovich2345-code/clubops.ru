import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { getEmployeesForScope } from "@/lib/club-employees";
import { getAssignmentsForEmployees } from "@/lib/payroll/assignments";
import { getSchemesForEmployee, resolveEffectiveScheme, describeSchemeShort } from "@/lib/payroll/schemes";
import { getPeriodsForScope, periodLabel } from "@/lib/payroll/periods";
import { PAYROLL_POSITION_LABELS } from "@/lib/payroll/enums";
import { PayrollNav } from "../_components/PayrollNav";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

type SetupStatus = "configured" | "no_scheme" | "no_assignment" | "needs_review" | "dismissed";
const SETUP: Record<SetupStatus, { label: string; cls: string }> = {
  configured: { label: "Настроен", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" },
  no_scheme: { label: "Нет схемы", cls: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" },
  no_assignment: { label: "Нет закрепления", cls: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" },
  needs_review: { label: "Требует проверки", cls: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" },
  dismissed: { label: "Уволен", cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" },
};

export default async function PayrollEmployeesPage() {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Сотрудники и схемы" description="Настройка оплаты сотрудников" />;
  const companyId = ctx.selectedCompanyId;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const showClub = clubs.length > 1;

  const rows = await getEmployeesForScope(companyId, clubIds, { status: "active" });
  const assignments = await getAssignmentsForEmployees(companyId, rows.map((r) => r.id));
  const now = new Date();

  // Effective scheme per employee (+ its start date).
  const schemeBy = new Map<string, { short: string; from: Date } | null>();
  await Promise.all(
    rows.map(async (r) => {
      const schemes = await getSchemesForEmployee(companyId, r.id);
      const eff = resolveEffectiveScheme(schemes, now);
      schemeBy.set(r.id, eff ? { short: describeSchemeShort(eff), from: eff.effectiveFrom } : null);
    }),
  );

  // Last calculation per employee (latest period the employee has a calc in).
  const periods = clubIds.length ? await getPeriodsForScope(companyId, clubIds) : [];
  const periodById = new Map(periods.map((p) => [p.id, p]));
  const calcs = periods.length
    ? await prisma.payrollCalculation.findMany({ where: { payrollPeriodId: { in: periods.map((p) => p.id) }, employeeId: { in: rows.map((r) => r.id) } }, select: { employeeId: true, payrollPeriodId: true } })
    : [];
  const lastCalcBy = new Map<string, string>();
  for (const c of calcs) {
    const p = periodById.get(c.payrollPeriodId);
    if (!p) continue;
    const prev = lastCalcBy.get(c.employeeId);
    const prevP = prev ? periodById.get(prev) : null;
    if (!prevP || p.year * 12 + p.month > prevP.year * 12 + prevP.month) lastCalcBy.set(c.employeeId, c.payrollPeriodId);
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Зарплата (ФОТ)" description="Сотрудники и схемы оплаты" />
      <PayrollNav />

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
                  {showClub ? <Th>Клуб</Th> : null}
                  <Th>Должность</Th>
                  <Th>Текущая схема</Th>
                  <Th>Схема с</Th>
                  <Th>Статус</Th>
                  <Th>Последний расчёт</Th>
                  <Th className="text-right">Действие</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {rows.map((e) => {
                  const asg = assignments.get(e.id) ?? [];
                  const scheme = schemeBy.get(e.id) ?? null;
                  const status: SetupStatus = asg.length === 0 ? "no_assignment" : !scheme ? "no_scheme" : "configured";
                  const lastP = lastCalcBy.get(e.id) ? periodById.get(lastCalcBy.get(e.id)!) : null;
                  return (
                    <tr key={e.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">{e.fullName}</Td>
                      {showClub ? <Td className="whitespace-nowrap">{e.clubName}</Td> : null}
                      <Td className="whitespace-nowrap">{PAYROLL_POSITION_LABELS[e.position] ?? e.position}</Td>
                      <Td>{scheme ? <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">{scheme.short}</span> : <span className="text-slate-400">—</span>}</Td>
                      <Td className="whitespace-nowrap text-slate-500 dark:text-slate-400">{scheme ? dateFmt.format(scheme.from) : "—"}</Td>
                      <Td><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${SETUP[status].cls}`}>{SETUP[status].label}</span></Td>
                      <Td className="whitespace-nowrap text-slate-500 dark:text-slate-400">{lastP ? periodLabel(lastP) : "—"}</Td>
                      <Td className="text-right">
                        <Link href={`/payroll/employees/${e.id}`} className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">Открыть</Link>
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
