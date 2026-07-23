import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { getEmployeeForScope } from "@/lib/club-employees";
import { getClubLegalEntities } from "@/lib/legal-entities";
import { getAssignmentsForEmployee } from "@/lib/payroll/assignments";
import { getSchemesForEmployee, resolveEffectiveScheme } from "@/lib/payroll/schemes";
import { canManagePayrollAssignments, canManagePaySchemes } from "@/lib/payroll/access";
import { PAYROLL_POSITION_LABELS, PAYROLL_SCHEME_LABELS } from "@/lib/payroll/enums";
import { formatKopeks } from "@/lib/money";
import { PayrollProfileForm } from "../../_components/PayrollProfileForm";
import { AssignmentForm } from "../../_components/AssignmentForm";
import { RemoveAssignmentButton } from "../../_components/RemoveAssignmentButton";
import { PaySchemeForm } from "../../_components/PaySchemeForm";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

export default async function PayrollEmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return <NoCompanyState title="Зарплата (ФОТ)" description="Настройка оплаты сотрудника" />;
  }
  const companyId = ctx.selectedCompanyId;
  const { id } = await params;

  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const employee = await getEmployeeForScope(companyId, clubIds, id);
  if (!employee) notFound();

  const clubName = (cid: string) => clubs.find((c) => c.id === cid)?.name ?? cid;
  const [assignments, schemes, legalEntities] = await Promise.all([
    getAssignmentsForEmployee(companyId, employee.id),
    getSchemesForEmployee(companyId, employee.id),
    getClubLegalEntities(employee.clubId),
  ]);
  const legalOptions = legalEntities.map((e) => ({ id: e.id, name: e.name }));
  const effective = resolveEffectiveScheme(schemes, new Date());
  const canAssign = canManagePayrollAssignments(ctx.effectiveRoles);
  const canScheme = canManagePaySchemes(ctx.effectiveRoles);

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-4">
        <Link href="/payroll" className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
          ← К списку
        </Link>
      </div>
      <PageHeader
        title={employee.fullName}
        description={`${PAYROLL_POSITION_LABELS[employee.position] ?? employee.position} · ${clubName(employee.clubId)}`}
      />

      {/* Profile */}
      <section className={`mb-6 p-5 ${CARD}`}>
        <h2 className="mb-4 text-sm font-semibold text-slate-700 dark:text-slate-200">Платёжный профиль</h2>
        {canAssign ? (
          <PayrollProfileForm
            employeeId={employee.id}
            initial={{
              hireDate: employee.hireDate ? employee.hireDate.toISOString().slice(0, 10) : "",
              preferredPaymentMethod: employee.preferredPaymentMethod ?? "",
              isOfficial: employee.isOfficial,
              defaultLegalEntityId: employee.defaultLegalEntityId ?? "",
            }}
            legalEntities={legalOptions}
          />
        ) : (
          <div className="text-sm text-slate-500 dark:text-slate-400">Только просмотр.</div>
        )}
      </section>

      {/* Assignments */}
      <section className={`mb-6 p-5 ${CARD}`}>
        <h2 className="mb-4 text-sm font-semibold text-slate-700 dark:text-slate-200">Закрепления за клубами</h2>
        {assignments.length === 0 ? (
          <div className="mb-4 text-sm text-slate-500 dark:text-slate-400">Нет закреплений.</div>
        ) : (
          <ul className="mb-4 divide-y divide-slate-100 dark:divide-slate-800/70">
            {assignments.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-slate-700 dark:text-slate-200">
                  {clubName(a.clubId)} · {PAYROLL_POSITION_LABELS[a.position] ?? a.position}
                  {a.earningShareBasisPoints != null ? (
                    <span className="ml-2 text-xs text-slate-400">доля {(a.earningShareBasisPoints / 100).toFixed(0)}%</span>
                  ) : null}
                </span>
                {canAssign ? <RemoveAssignmentButton employeeId={employee.id} assignmentId={a.id} /> : null}
              </li>
            ))}
          </ul>
        )}
        {canAssign ? <AssignmentForm employeeId={employee.id} clubs={clubs} /> : null}
      </section>

      {/* Pay schemes */}
      <section className={`mb-6 p-5 ${CARD}`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Схемы оплаты (история)</h2>
          {effective ? (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">
              Действует: {PAYROLL_SCHEME_LABELS[effective.schemeType] ?? effective.schemeType}
            </span>
          ) : null}
        </div>
        {schemes.length === 0 ? (
          <div className="mb-4 text-sm text-slate-500 dark:text-slate-400">Схема оплаты не задана.</div>
        ) : (
          <div className="mb-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-2 py-1.5 text-left">Клуб</th>
                  <th className="px-2 py-1.5 text-left">Тип</th>
                  <th className="px-2 py-1.5 text-left">Действует с</th>
                  <th className="px-2 py-1.5 text-left">По</th>
                  <th className="px-2 py-1.5 text-left">Параметры</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {schemes.map((s) => (
                  <tr key={s.id}>
                    <td className="px-2 py-1.5">{clubName(s.clubId)}</td>
                    <td className="px-2 py-1.5">{PAYROLL_SCHEME_LABELS[s.schemeType] ?? s.schemeType}</td>
                    <td className="px-2 py-1.5">{dateFmt.format(s.effectiveFrom)}</td>
                    <td className="px-2 py-1.5">{s.effectiveTo ? dateFmt.format(s.effectiveTo) : "открыта"}</td>
                    <td className="px-2 py-1.5 text-slate-500 dark:text-slate-400">{summarizeParams(s.paramsJson)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canScheme ? (
          <PaySchemeForm employeeId={employee.id} clubs={clubs} defaultClubId={employee.clubId} />
        ) : (
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Настройка схем доступна региональному директору, главному бухгалтеру или собственнику.
          </div>
        )}
      </section>
    </div>
  );
}

// Compact params summary: show kopeks fields as rubles, bp fields as %.
function summarizeParams(paramsJson: string): string {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(paramsJson) as Record<string, unknown>;
  } catch {
    return "—";
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== "number") continue;
    if (k.endsWith("Kopeks")) parts.push(`${k.replace("Kopeks", "")}: ${formatKopeks(v)}`);
    else if (k.endsWith("Bp")) parts.push(`${k.replace("Bp", "")}: ${(v / 100).toFixed(v % 100 === 0 ? 0 : 2)}%`);
    else parts.push(`${k}: ${v}`);
  }
  return parts.join("; ") || "—";
}
