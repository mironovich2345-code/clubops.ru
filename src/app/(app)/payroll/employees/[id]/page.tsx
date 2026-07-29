import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { ChevronDownIcon } from "@/components/mobile/icons";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { getEmployeeForScope } from "@/lib/club-employees";
import { getClubLegalEntities } from "@/lib/legal-entities";
import { getAssignmentsForEmployee } from "@/lib/payroll/assignments";
import { getObligationsForEmployee, OBLIGATION_DIRECTION_LABELS, OBLIGATION_STATUS_LABELS } from "@/lib/payroll/obligations";
import { getSchemesForEmployee, resolveEffectiveScheme } from "@/lib/payroll/schemes";
import { canManagePayrollAssignments, canManagePaySchemes } from "@/lib/payroll/access";
import { PAYROLL_POSITION_LABELS, PAYROLL_SCHEME_LABELS } from "@/lib/payroll/enums";
import { formatKopeks } from "@/lib/money";
import { PayrollProfileForm } from "../../_components/PayrollProfileForm";
import { AssignmentForm } from "../../_components/AssignmentForm";
import { RemoveAssignmentButton } from "../../_components/RemoveAssignmentButton";
import { PaySchemeForm } from "../../_components/PaySchemeForm";
import { EmployeeAdvancePanel, type EmployeeAdvanceRow } from "../../_components/EmployeeAdvancePanel";
import { prisma } from "@/lib/prisma";

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
  const [assignments, schemes, legalEntities, obligations] = await Promise.all([
    getAssignmentsForEmployee(companyId, employee.id),
    getSchemesForEmployee(companyId, employee.id),
    getClubLegalEntities(employee.clubId),
    getObligationsForEmployee(companyId, employee.id),
  ]);
  const legalOptions = legalEntities.map((e) => ({ id: e.id, name: e.name }));
  const effective = resolveEffectiveScheme(schemes, new Date());
  const canAssign = canManagePayrollAssignments(ctx.effectiveRoles);
  const canScheme = canManagePaySchemes(ctx.effectiveRoles);

  // Advances (pre-period) for this employee — recent months.
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const advanceRows: EmployeeAdvanceRow[] = (
    await prisma.payrollAdvance.findMany({ where: { companyId, employeeId: employee.id }, orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }], take: 12 })
  ).map((a) => ({ id: a.id, periodYear: a.periodYear, periodMonth: a.periodMonth, amountKopeks: a.amountKopeks, method: a.paymentMethod, status: a.status, earnedToDateSource: a.earnedToDateSource, comment: a.comment }));
  const canApproveAdvance = ctx.effectiveRoles.includes("regional_director");

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-4">
        <Link href="/payroll/employees" className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
          ← Сотрудники и схемы
        </Link>
      </div>
      <PageHeader
        title={employee.fullName}
        description={`${PAYROLL_POSITION_LABELS[employee.position] ?? employee.position} · ${clubName(employee.clubId)}`}
      />

      {/* Платёжный профиль — primary section, always open. */}
      <section className={`mb-4 p-4 sm:p-5 ${CARD}`}>
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
          <p className="text-xs text-slate-400 dark:text-slate-500">Только просмотр.</p>
        )}
      </section>

      {/* Закрепления — secondary, collapsible. */}
      <AccordionSection title="Закрепления за клубами" hint={`${assignments.length}`}>
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
      </AccordionSection>

      {/* Схема оплаты — secondary, collapsible. */}
      <AccordionSection
        title="Схема оплаты"
        hint={effective ? `Действует: ${PAYROLL_SCHEME_LABELS[effective.schemeType] ?? effective.schemeType}` : undefined}
      >
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
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Настройка схем доступна региональному директору, главному бухгалтеру или собственнику.
          </p>
        )}
      </AccordionSection>

      {/* Авансы — secondary, collapsible (pre-period — открытый текущий месяц). */}
      <AccordionSection title="Авансы">
        <EmployeeAdvancePanel
          employeeId={employee.id}
          clubId={employee.clubId}
          currentMonth={currentMonth}
          canManage={canAssign}
          canApprove={canApproveAdvance}
          advances={advanceRows}
        />
      </AccordionSection>

      {/* Долги — secondary, collapsible (survive dismissal — never auto-written-off). */}
      <AccordionSection
        title="Долги и обязательства"
        action={<Link href="/payroll/obligations" className="text-xs text-brand-600 hover:text-brand-700">Погашение →</Link>}
      >
        {employee.status === "dismissed" ? (
          <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">
            Сотрудник уволен. Обязательства сохраняются и не списываются автоматически.
          </p>
        ) : null}
        {obligations.length === 0 ? (
          <p className="text-xs text-slate-400 dark:text-slate-500">Обязательств нет.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {obligations.map((o) => (
              <li key={o.id} className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-300">
                  {OBLIGATION_DIRECTION_LABELS[o.direction] ?? o.direction} · {o.reason}
                </span>
                <span className="tabular-nums">
                  <span className={o.direction === "employee_owes_company" ? "text-rose-600" : "text-emerald-600"}>
                    {formatKopeks(o.outstandingAmountKopeks)}
                  </span>
                  <span className="ml-2 text-xs text-slate-400">{OBLIGATION_STATUS_LABELS[o.status] ?? o.status}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </AccordionSection>
    </div>
  );
}

/**
 * Collapsible secondary section (spec §3). Native <details> so it stays
 * Server-Component-safe (no client JS). Consistent card padding/gaps with the
 * primary profile section; the chevron rotates on open.
 */
function AccordionSection({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <details className={`group mb-4 ${CARD}`}>
      <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</span>
          {hint ? <span className="truncate text-xs font-normal text-slate-400 dark:text-slate-500">{hint}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {action}
          <ChevronDownIcon className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="px-4 pb-5 sm:px-5">{children}</div>
    </details>
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
