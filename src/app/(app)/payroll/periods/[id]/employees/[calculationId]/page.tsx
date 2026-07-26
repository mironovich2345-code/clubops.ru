import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { getPeriodForScope, getCalculations, periodLabel, periodStatusLabel } from "@/lib/payroll/periods";
import { isPayrollPeriodLocked, isPayrollPeriodClosed } from "@/lib/payroll/period";
import { canManagePayrollAssignments, canAddPayrollAdjustment } from "@/lib/payroll/access";
import { PAYROLL_POSITION_LABELS, PAYROLL_SCHEME_LABELS } from "@/lib/payroll/enums";
import { formatKopeks } from "@/lib/money";
import { getActiveClubLegalEntities } from "@/lib/legal-entities";
import { CalculationCard, type BreakdownLine } from "../../../../_components/CalculationCard";
import { AdjustmentsSection, type AdjustmentRow } from "../../../../_components/AdjustmentsSection";
import { PaymentsSection, type PaymentRow, type AdvanceRow, type LegalEntityOption } from "../../../../_components/PaymentsSection";
import { TrainerPackages, type TrainerSummaryVM, type TrainerPackageVM } from "../../../../_components/TrainerPackages";
import { ProposeChangeSection, type ProposeFieldOption, type ChangeRequestRow } from "../../../../_components/ProposeChangeSection";
import { canProposePayrollChange } from "@/lib/payroll/access";
import { allowedFieldsForScheme, effectiveSchemeParams, formatFieldValue } from "@/lib/payroll/change-request";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const rubStr = (kopeks: number) => (kopeks / 100).toString();

export default async function PayrollEmployeeCalcPage({ params }: { params: Promise<{ id: string; calculationId: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Расчёт сотрудника" description="Начисление зарплаты" />;
  const companyId = ctx.selectedCompanyId;
  const { id, calculationId } = await params;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const period = await getPeriodForScope(companyId, clubIds, id);
  if (!period) notFound();
  const calcs = await getCalculations(period.id);
  const c = calcs.find((x) => x.id === calculationId);
  if (!c) notFound();

  const clubName = clubs.find((x) => x.id === period.clubId)?.name ?? period.clubId;
  const employee = await prisma.clubEmployee.findUnique({ where: { id: c.employeeId }, select: { fullName: true, status: true } });
  const employeeName = employee?.fullName ?? c.employeeId;
  const dismissed = employee?.status === "dismissed";

  const locked = isPayrollPeriodLocked(period.status);
  const closed = isPayrollPeriodClosed(period.status);
  const canManage = canManagePayrollAssignments(ctx.effectiveRoles);
  const canAdjust = !closed && canAddPayrollAdjustment(ctx.effectiveRoles, { locked });

  const snap = parseSnapshot(c.schemeSnapshotJson);
  const details = parseDetails(c.detailsJson);
  const initial: Record<string, string> = {};
  if (c.shifts != null) initial.actualShifts = String(c.shifts);
  if (c.hours != null) initial.hours = String(c.hours);
  if (c.salesBaseKopeks) { initial.sales = rubStr(c.salesBaseKopeks); initial.netPersonalSales = rubStr(c.salesBaseKopeks); }
  if (c.profitBaseKopeks) initial.cityProfit = rubStr(c.profitBaseKopeks);

  const [adjustments, payments, paidAdvance] = await Promise.all([
    prisma.payrollAdjustment.findMany({ where: { payrollCalculationId: c.id, status: "approved" }, orderBy: { createdAt: "asc" } }),
    prisma.payrollPayment.findMany({ where: { payrollCalculationId: c.id, status: "confirmed" }, orderBy: { paymentDate: "asc" } }),
    prisma.payrollAdvance.findFirst({ where: { companyId, clubId: period.clubId, employeeId: c.employeeId, periodYear: period.year, periodMonth: period.month, status: "paid" } }),
  ]);
  const adjRows: AdjustmentRow[] = adjustments.map((a) => ({ id: a.id, type: a.type, direction: a.direction, amountKopeks: a.amountKopeks, comment: a.comment }));
  const payRows: PaymentRow[] = payments.map((p) => ({ id: p.id, amountKopeks: p.amountKopeks, method: p.paymentMethod, status: p.status }));
  const advanceRow: AdvanceRow | null = paidAdvance ? { id: paidAdvance.id, amountKopeks: paidAdvance.amountKopeks, method: paidAdvance.paymentMethod ?? "cash" } : null;

  const packages = snap?.schemeType === "gym_trainer"
    ? (await prisma.payrollTrainerPackage.findMany({ where: { payrollCalculationId: c.id }, orderBy: { createdAt: "asc" } })).map((p): TrainerPackageVM => ({ id: p.id, clientRef: p.clientRef, contractNumber: p.contractNumber, contractAmountKopeks: p.contractAmountKopeks, sessionCount: p.sessionCount, providedSessions: p.providedSessions, refundKopeks: p.refundKopeks, trainerRateBp: p.trainerRateBp, seniorTrainerConfirmed: p.seniorTrainerConfirmed }))
    : [];

  // STAGE 10–11: change proposals. Whitelisted scheme fields + their CURRENT effective
  // value (base snapshot + already-approved overrides), and this calc's change requests.
  const canPropose = !closed && canProposePayrollChange(ctx.effectiveRoles);
  const effScheme = effectiveSchemeParams(c.schemeSnapshotJson, c.approvedOverridesJson);
  const effParams = (effScheme?.params ?? {}) as Record<string, unknown>;
  const proposeFields: ProposeFieldOption[] = snap
    ? allowedFieldsForScheme(snap.schemeType).map((f) => ({ key: f.key, fieldType: f.fieldType, unit: f.unit, labelRu: f.labelRu, currentDisplay: formatFieldValue(f.unit, effParams[f.key]) }))
    : [];
  const changeReqRows: ChangeRequestRow[] = (
    await prisma.payrollChangeRequest.findMany({ where: { payrollCalculationId: c.id }, orderBy: { createdAt: "desc" } })
  ).map((r) => ({ id: r.id, requestType: r.requestType, fieldType: r.fieldType, targetField: r.targetField, status: r.status, impactKopeks: r.calculatedImpactKopeks, impactUncomputable: r.impactUncomputable, revision: r.revision }));

  const payable = !closed && ["approved", "partially_paid", "paid"].includes(period.status);
  const canPayCash = canManage;
  const canPayBank = ctx.effectiveRoles.some((r) => r === "accountant" || r === "chief_accountant");
  const { ooo, ip } = await getActiveClubLegalEntities(period.clubId);
  const legalEntityOptions: LegalEntityOption[] = [
    ip ? { id: ip.id, name: ip.name, type: "ip" as const } : null,
    ooo ? { id: ooo.id, name: ooo.name, type: "ooo" as const } : null,
  ].filter((x): x is LegalEntityOption => x !== null);

  return (
    <div className="mx-auto max-w-[900px]">
      <div className="mb-4">
        <Link href={`/payroll/periods/${period.id}`} className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">← {clubName} · {periodLabel(period)}</Link>
      </div>
      <PageHeader title={employeeName} description={`${PAYROLL_POSITION_LABELS[c.roleSnapshot ?? ""] ?? c.roleSnapshot ?? "—"} · ${clubName} · период ${periodStatusLabel(period.status)}`} />

      {/* Header stats */}
      <div className={`mb-5 grid grid-cols-2 gap-4 p-5 sm:grid-cols-4 ${CARD}`}>
        <Stat label="Начислено" value={formatKopeks(c.grossAccruedKopeks)} />
        <Stat label="Выплачено" value={formatKopeks(c.paidKopeks)} />
        <Stat label="Остаток" value={formatKopeks(c.remainingKopeks)} accent={c.remainingKopeks > 0} />
        <Stat label="Долг" value={formatKopeks(c.employeeDebtKopeks)} accent={c.employeeDebtKopeks > 0} />
      </div>

      <div className={`overflow-hidden ${CARD}`}>
        <div className="p-4">
          <CalculationCard
            calculationId={c.id}
            employeeName={employeeName}
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
          <AdjustmentsSection calculationId={c.id} adjustments={adjRows} canAdd={canAdjust} />
          {snap?.schemeType === "gym_trainer" ? (
            <TrainerPackages calculationId={c.id} summary={details.trainer} paidKopeks={c.paidKopeks} employeeDebtKopeks={c.employeeDebtKopeks} packages={packages} canManage={canManage} locked={locked} employeeDismissed={dismissed} />
          ) : null}
          <PaymentsSection
            calculationId={c.id}
            advance={advanceRow}
            payments={payRows}
            netPayableKopeks={c.netPayableKopeks}
            paidKopeks={c.paidKopeks}
            remainingKopeks={c.remainingKopeks}
            payable={payable}
            canPayCash={canPayCash}
            canPayBank={canPayBank}
            legalEntities={legalEntityOptions}
          />
          <ProposeChangeSection
            calculationId={c.id}
            fields={proposeFields}
            requests={changeReqRows}
            canPropose={canPropose}
            unitHint={{ kopeks: "₽", bp: "%", count: "шт" }}
          />
        </div>
      </div>
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
  try { const s = JSON.parse(json) as { schemeType?: string }; return s.schemeType ? { schemeType: s.schemeType } : null; } catch { return null; }
}
function parseDetails(json: string | null): { breakdown: BreakdownLine[]; warnings: string[]; trainer: TrainerSummaryVM | null } {
  if (!json) return { breakdown: [], warnings: [], trainer: null };
  try { const d = JSON.parse(json) as { breakdown?: BreakdownLine[]; warnings?: string[]; trainer?: TrainerSummaryVM }; return { breakdown: Array.isArray(d.breakdown) ? d.breakdown : [], warnings: Array.isArray(d.warnings) ? d.warnings : [], trainer: d.trainer ?? null }; } catch { return { breakdown: [], warnings: [], trainer: null }; }
}
