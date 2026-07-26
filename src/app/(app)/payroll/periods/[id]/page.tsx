import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { getPeriodForScope, getCalculations, periodTotals, periodLabel, periodStatusLabel } from "@/lib/payroll/periods";
import { isPayrollPeriodLocked, isPayrollPeriodClosed, availablePayrollActions, PAYROLL_ACTION_LABELS } from "@/lib/payroll/period";
import { canManagePayrollAssignments, canAddPayrollAdjustment } from "@/lib/payroll/access";
import { PAYROLL_POSITION_LABELS, PAYROLL_SCHEME_LABELS } from "@/lib/payroll/enums";
import { formatKopeks } from "@/lib/money";
import { GeneratePeriodButton } from "../../_components/GeneratePeriodButton";
import { type BreakdownLine } from "../../_components/CalculationCard";
import { PeriodWorkflowBar } from "../../_components/PeriodWorkflowBar";
import { PeriodRoster, type RosterRow } from "../../_components/PeriodRoster";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const CALC_STATUS_LABEL: Record<string, string> = { draft: "Черновик", calculated: "Рассчитан", approved: "Утверждён", paid: "Выплачен", closed: "Закрыт" };

export default async function PayrollPeriodPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return <NoCompanyState title="Расчётный период" description="Начисления зарплаты" />;
  }
  const companyId = ctx.selectedCompanyId;
  const { id } = await params;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const period = await getPeriodForScope(companyId, clubIds, id);
  if (!period) notFound();

  const clubName = clubs.find((c) => c.id === period.clubId)?.name ?? period.clubId;
  const calcs = await getCalculations(period.id);
  const employees = calcs.length
    ? await prisma.clubEmployee.findMany({ where: { id: { in: calcs.map((c) => c.employeeId) } }, select: { id: true, fullName: true, status: true } })
    : [];
  const nameBy = new Map(employees.map((e) => [e.id, e.fullName]));
  const dismissedBy = new Map(employees.map((e) => [e.id, e.status === "dismissed"]));

  const totals = periodTotals(calcs);
  const locked = isPayrollPeriodLocked(period.status);
  const canManage = canManagePayrollAssignments(ctx.effectiveRoles);
  const workflowActions = availablePayrollActions(period.status, ctx.effectiveRoles).map((a) => ({ action: a, label: PAYROLL_ACTION_LABELS[a] }));

  // Compact roster rows (§6): summary + link to the per-employee calc page.
  const rosterRows: RosterRow[] = calcs.map((c) => {
    const snap = parseSnapshot(c.schemeSnapshotJson);
    const details = parseDetails(c.detailsJson);
    return {
      calculationId: c.id,
      name: nameBy.get(c.employeeId) ?? c.employeeId,
      roleLabel: PAYROLL_POSITION_LABELS[c.roleSnapshot ?? ""] ?? c.roleSnapshot ?? "—",
      schemeLabel: snap ? PAYROLL_SCHEME_LABELS[snap.schemeType] ?? snap.schemeType : "Схема не задана",
      status: c.status,
      statusLabel: CALC_STATUS_LABEL[c.status] ?? c.status,
      grossKopeks: c.grossAccruedKopeks,
      paidKopeks: c.paidKopeks,
      remainingKopeks: c.remainingKopeks,
      problems: details.warnings.length,
      breakdown: details.breakdown.filter((b) => typeof b.valueKopeks === "number").map((b) => ({ label: b.label, amountKopeks: b.valueKopeks! })),
    };
  });

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-4">
        <Link href="/payroll/periods" className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
          ← Расчётные периоды
        </Link>
      </div>
      <PageHeader title={`${clubName} · ${periodLabel(period)}`} description={`Статус: ${periodStatusLabel(period.status)}`} />

      {/* Totals */}
      <div className={`mb-6 grid grid-cols-2 gap-4 p-5 sm:grid-cols-4 ${CARD}`}>
        <Stat label="Сотрудников" value={String(totals.count)} />
        <Stat label="Начислено" value={formatKopeks(totals.grossAccruedKopeks)} />
        <Stat label="К выплате" value={formatKopeks(totals.netPayableKopeks)} />
        <Stat label="Требуют решения" value={String(totals.needsReview)} accent={totals.needsReview > 0} />
      </div>

      {workflowActions.length > 0 ? (
        <div className={`mb-6 p-5 ${CARD}`}>
          <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Согласование</div>
          <PeriodWorkflowBar periodId={period.id} actions={workflowActions} />
        </div>
      ) : null}

      {canManage && !locked ? (
        <div className="mb-6">
          <GeneratePeriodButton periodId={period.id} hasCalcs={calcs.length > 0} />
          <p className="mt-2 text-xs text-slate-400">
            Формирует по одному расчёту на каждого закреплённого сотрудника и фиксирует схему оплаты на этот месяц. Управляющим со схемой «оклад по плану-факту» план и факт подставляются из ОФД/плана продаж (предварительный ФОТ) — проверьте перед согласованием. Введённые данные не перезаписываются.
          </p>
        </div>
      ) : null}

      {calcs.length === 0 ? (
        <div className={`px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
          Пока нет расчётов. {canManage ? "Сформируйте состав по закреплениям." : ""}
        </div>
      ) : (
        <PeriodRoster periodId={period.id} rows={rosterRows} />
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${accent ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100"}`}>{value}</div>
    </div>
  );
}

function parseSnapshot(json: string | null): { schemeType: string } | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as { schemeType?: string };
    return s.schemeType ? { schemeType: s.schemeType } : null;
  } catch {
    return null;
  }
}
function parseDetails(json: string | null): { breakdown: BreakdownLine[]; warnings: string[] } {
  if (!json) return { breakdown: [], warnings: [] };
  try {
    const d = JSON.parse(json) as { breakdown?: BreakdownLine[]; warnings?: string[] };
    return { breakdown: Array.isArray(d.breakdown) ? d.breakdown : [], warnings: Array.isArray(d.warnings) ? d.warnings : [] };
  } catch {
    return { breakdown: [], warnings: [] };
  }
}
