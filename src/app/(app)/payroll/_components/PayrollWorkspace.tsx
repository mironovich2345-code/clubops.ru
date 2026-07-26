import Link from "next/link";
import type { Role } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getCalculations, periodTotals, periodLabel, periodStatusLabel } from "@/lib/payroll/periods";
import { isPayrollPeriodLocked, availablePayrollActions, PAYROLL_ACTION_LABELS } from "@/lib/payroll/period";
import { canManagePayrollAssignments } from "@/lib/payroll/access";
import { PAYROLL_POSITION_LABELS, PAYROLL_SCHEME_LABELS } from "@/lib/payroll/enums";
import { formatKopeks } from "@/lib/money";
import { GeneratePeriodButton } from "./GeneratePeriodButton";
import { type BreakdownLine } from "./CalculationCard";
import { PeriodWorkflowBar } from "./PeriodWorkflowBar";
import { PeriodRoster, type RosterRow } from "./PeriodRoster";
import { PeriodCategoryCards, type CategoryCard } from "./PeriodCategoryCards";
import { payrollCategoryOfPosition, payrollUiGroupOfCategory, UI_GROUP_LABELS, type PayrollUiGroup } from "@/lib/payroll/categories";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const CALC_STATUS_LABEL: Record<string, string> = { draft: "Черновик", calculated: "Рассчитан", approved: "Утверждён", paid: "Выплачен", closed: "Закрыт" };

type PeriodLike = { id: string; clubId: string; status: string; year: number; month: number };

/**
 * The single payroll WORKING screen (spec §1/§5): totals + progress + the five category
 * cards + roster + workflow. Rendered both at `/payroll` (manager landing) and at
 * `/payroll/periods/[id]` (deep link for other roles). `basePath` + `keepParams` build the
 * card/group links so the manager stays on `/payroll` while other roles stay on the period
 * route — one screen, no duplicate technical table.
 */
export async function PayrollWorkspace({
  period,
  clubs,
  effectiveRoles,
  basePath,
  keepParams = {},
  group,
}: {
  period: PeriodLike;
  clubs: Array<{ id: string; name: string }>;
  effectiveRoles: readonly Role[];
  basePath: string;
  keepParams?: Record<string, string>;
  group?: string;
}) {
  const clubName = clubs.find((c) => c.id === period.clubId)?.name ?? period.clubId;
  const calcs = await getCalculations(period.id);
  const employees = calcs.length
    ? await prisma.clubEmployee.findMany({ where: { id: { in: calcs.map((c) => c.employeeId) } }, select: { id: true, fullName: true, status: true } })
    : [];
  const nameBy = new Map(employees.map((e) => [e.id, e.fullName]));

  const totals = periodTotals(calcs);
  const locked = isPayrollPeriodLocked(period.status);
  const canManage = canManagePayrollAssignments(effectiveRoles);
  const workflowActions = availablePayrollActions(period.status, effectiveRoles).map((a) => ({ action: a, label: PAYROLL_ACTION_LABELS[a] }));

  // Build a link on the same base screen, preserving month/club (+ optional group).
  const qs = (extra: Record<string, string>) => {
    const params = new URLSearchParams({ ...keepParams, ...extra });
    const s = params.toString();
    return s ? `${basePath}?${s}` : basePath;
  };

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

  const uiGroupByCalc = new Map<string, PayrollUiGroup>();
  for (const c of calcs) {
    const cat = payrollCategoryOfPosition(c.roleSnapshot);
    uiGroupByCalc.set(c.id, cat === "unknown" ? "administrative_card" : payrollUiGroupOfCategory(cat));
  }
  const GROUPS: PayrollUiGroup[] = ["manager_card", "administrative_card", "gym_trainers_card", "group_trainers_card"];
  const cardStatus = (count: number, filled: number, problems: number): string =>
    count === 0 ? "Не начато" : problems > 0 ? "Требует проверки" : filled >= count ? "Заполнено" : "Требует заполнения";
  const cards: CategoryCard[] = GROUPS.map((g): CategoryCard => {
    const ids = calcs.filter((c) => uiGroupByCalc.get(c.id) === g);
    const filled = ids.filter((c) => c.status !== "draft").length;
    const problems = ids.reduce((s, c) => s + parseDetails(c.detailsJson).warnings.length, 0);
    const prelim = ids.reduce((s, c) => s + c.grossAccruedKopeks, 0);
    return { group: g, label: UI_GROUP_LABELS[g], count: ids.length, filled, problems, prelimKopeks: prelim, status: cardStatus(ids.length, filled, problems), href: qs({ group: g }) };
  });
  // 5th card — advances (cross-category). Kept as the manager's advance entry point (§9).
  const advanceHref = `/payroll/advances?month=${period.year}-${String(period.month).padStart(2, "0")}&club=${period.clubId}`;
  cards.push({ group: "advances_card", label: UI_GROUP_LABELS.advances_card, count: 0, filled: 0, problems: 0, prelimKopeks: 0, status: "", href: advanceHref });

  const activeGroup = GROUPS.includes(group as PayrollUiGroup) ? (group as PayrollUiGroup) : null;
  const visibleRoster = activeGroup ? rosterRows.filter((r) => uiGroupByCalc.get(r.calculationId) === activeGroup) : rosterRows;
  const filledTotal = calcs.filter((c) => c.status !== "draft").length;

  return (
    <>
      {/* Totals + progress (§18) */}
      <div className={`mb-6 grid grid-cols-2 gap-4 p-5 sm:grid-cols-4 ${CARD}`}>
        <Stat label="Сотрудников" value={String(totals.count)} />
        <Stat label="Начислено" value={formatKopeks(totals.grossAccruedKopeks)} />
        <Stat label="К выплате" value={formatKopeks(totals.netPayableKopeks)} />
        <Stat label="Требуют решения" value={String(totals.needsReview)} accent={totals.needsReview > 0} />
      </div>
      {calcs.length > 0 ? <p className="-mt-3 mb-6 text-sm text-slate-500 dark:text-slate-400">Расчёт заполнен на {filledTotal} из {calcs.length} сотрудников.</p> : null}

      {/* Five payroll cards (§5) */}
      {calcs.length > 0 ? <PeriodCategoryCards cards={cards} /> : null}

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
        <>
          {activeGroup ? (
            <div className="mb-3 flex items-center gap-2 text-sm">
              <span className="font-medium text-slate-700 dark:text-slate-200">{UI_GROUP_LABELS[activeGroup]}</span>
              <Link href={qs({})} className="text-xs text-brand-600 hover:text-brand-700">× показать всех</Link>
            </div>
          ) : null}
          <PeriodRoster periodId={period.id} rows={visibleRoster} />
        </>
      )}
    </>
  );
}

// Export helpers so callers (period header) reuse the same labels.
export { periodLabel, periodStatusLabel };

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
