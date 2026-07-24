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
import { CalculationCard, type BreakdownLine } from "../../_components/CalculationCard";
import { PeriodWorkflowBar } from "../../_components/PeriodWorkflowBar";
import { AdjustmentsSection, type AdjustmentRow } from "../../_components/AdjustmentsSection";
import { PaymentsSection, type PaymentRow, type AdvanceRow } from "../../_components/PaymentsSection";
import { TrainerPackages, type TrainerSummaryVM, type TrainerPackageVM } from "../../_components/TrainerPackages";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const rubStr = (kopeks: number) => (kopeks / 100).toString();

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

  // Trainer packages for gym-trainer calculations, grouped by calculation.
  const gymCalcIds = calcs.filter((c) => parseSnapshot(c.schemeSnapshotJson)?.schemeType === "gym_trainer").map((c) => c.id);
  const allPackages = gymCalcIds.length
    ? await prisma.payrollTrainerPackage.findMany({ where: { payrollCalculationId: { in: gymCalcIds } }, orderBy: { createdAt: "asc" } })
    : [];
  const pkgBy = new Map<string, TrainerPackageVM[]>();
  for (const p of allPackages) {
    const list = pkgBy.get(p.payrollCalculationId) ?? [];
    list.push({ id: p.id, clientRef: p.clientRef, contractNumber: p.contractNumber, contractAmountKopeks: p.contractAmountKopeks, sessionCount: p.sessionCount, providedSessions: p.providedSessions, refundKopeks: p.refundKopeks, trainerRateBp: p.trainerRateBp, seniorTrainerConfirmed: p.seniorTrainerConfirmed });
    pkgBy.set(p.payrollCalculationId, list);
  }
  const totals = periodTotals(calcs);
  const locked = isPayrollPeriodLocked(period.status);
  const closed = isPayrollPeriodClosed(period.status);
  const canManage = canManagePayrollAssignments(ctx.effectiveRoles);
  const canAdjust = !closed && canAddPayrollAdjustment(ctx.effectiveRoles, { locked });
  const workflowActions = availablePayrollActions(period.status, ctx.effectiveRoles).map((a) => ({ action: a, label: PAYROLL_ACTION_LABELS[a] }));

  const allAdjustments = calcs.length
    ? await prisma.payrollAdjustment.findMany({
        where: { payrollCalculationId: { in: calcs.map((c) => c.id) }, status: "approved" },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const adjBy = new Map<string, AdjustmentRow[]>();
  for (const a of allAdjustments) {
    const list = adjBy.get(a.payrollCalculationId) ?? [];
    list.push({ id: a.id, type: a.type, direction: a.direction, amountKopeks: a.amountKopeks, comment: a.comment });
    adjBy.set(a.payrollCalculationId, list);
  }

  // Payments (confirmed) per calc + paid advances (per employee for this month).
  const allPayments = calcs.length
    ? await prisma.payrollPayment.findMany({
        where: { payrollCalculationId: { in: calcs.map((c) => c.id) }, status: "confirmed" },
        orderBy: { paymentDate: "asc" },
      })
    : [];
  const payBy = new Map<string, PaymentRow[]>();
  for (const p of allPayments) {
    const list = payBy.get(p.payrollCalculationId) ?? [];
    list.push({ id: p.id, amountKopeks: p.amountKopeks, method: p.paymentMethod, status: p.status });
    payBy.set(p.payrollCalculationId, list);
  }
  const paidAdvances = await prisma.payrollAdvance.findMany({
    where: { companyId, clubId: period.clubId, periodYear: period.year, periodMonth: period.month, status: "paid" },
  });
  const advByEmployee = new Map<string, AdvanceRow>(
    paidAdvances.map((a) => [a.employeeId, { id: a.id, amountKopeks: a.amountKopeks, method: a.paymentMethod ?? "cash" }]),
  );

  const payable = !closed && ["approved", "partially_paid", "paid"].includes(period.status);
  const canPayCash = canManagePayrollAssignments(ctx.effectiveRoles);
  const canPayBank = ctx.effectiveRoles.some((r) => r === "accountant" || r === "chief_accountant");

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
        <div className="space-y-4">
          {calcs.map((c) => {
            const snap = parseSnapshot(c.schemeSnapshotJson);
            const details = parseDetails(c.detailsJson);
            const initial: Record<string, string> = {};
            if (c.shifts != null) initial.actualShifts = String(c.shifts);
            if (c.hours != null) initial.hours = String(c.hours);
            if (c.salesBaseKopeks) { initial.sales = rubStr(c.salesBaseKopeks); initial.netPersonalSales = rubStr(c.salesBaseKopeks); }
            if (c.profitBaseKopeks) initial.cityProfit = rubStr(c.profitBaseKopeks);
            return (
              <div key={c.id} className={`overflow-hidden ${CARD}`}>
                <div className="p-4">
                  <CalculationCard
                    calculationId={c.id}
                    employeeName={nameBy.get(c.employeeId) ?? c.employeeId}
                    roleLabel={PAYROLL_POSITION_LABELS[c.roleSnapshot ?? ""] ?? c.roleSnapshot ?? "—"}
                    schemeType={snap?.schemeType ?? null}
                    schemeLabel={snap ? PAYROLL_SCHEME_LABELS[snap.schemeType] ?? snap.schemeType : "Схема не задана"}
                    status={c.status}
                    automaticKopeks={c.automaticAmountKopeks}
                    grossKopeks={c.grossAccruedKopeks}
                    breakdown={details.breakdown}
                    warnings={details.warnings}
                    locked={locked || !canManage}
                    initial={initial}
                  />
                  <AdjustmentsSection calculationId={c.id} adjustments={adjBy.get(c.id) ?? []} canAdd={canAdjust} />
                  {snap?.schemeType === "gym_trainer" ? (
                    <TrainerPackages
                      calculationId={c.id}
                      summary={details.trainer}
                      paidKopeks={c.paidKopeks}
                      employeeDebtKopeks={c.employeeDebtKopeks}
                      packages={pkgBy.get(c.id) ?? []}
                      canManage={canManage}
                      locked={locked}
                      employeeDismissed={dismissedBy.get(c.employeeId) ?? false}
                    />
                  ) : null}
                  <PaymentsSection
                    calculationId={c.id}
                    advance={advByEmployee.get(c.employeeId) ?? null}
                    payments={payBy.get(c.id) ?? []}
                    netPayableKopeks={c.netPayableKopeks}
                    paidKopeks={c.paidKopeks}
                    remainingKopeks={c.remainingKopeks}
                    payable={payable}
                    canPayCash={canPayCash}
                    canPayBank={canPayBank}
                  />
                </div>
              </div>
            );
          })}
        </div>
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
function parseDetails(json: string | null): { breakdown: BreakdownLine[]; warnings: string[]; trainer: TrainerSummaryVM | null } {
  if (!json) return { breakdown: [], warnings: [], trainer: null };
  try {
    const d = JSON.parse(json) as { breakdown?: BreakdownLine[]; warnings?: string[]; trainer?: TrainerSummaryVM };
    return { breakdown: Array.isArray(d.breakdown) ? d.breakdown : [], warnings: Array.isArray(d.warnings) ? d.warnings : [], trainer: d.trainer ?? null };
  } catch {
    return { breakdown: [], warnings: [], trainer: null };
  }
}
