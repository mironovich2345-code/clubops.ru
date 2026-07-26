"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, recordAudit } from "@/lib/access";
import { canManagePayrollAssignments } from "@/lib/payroll/access";
import { getPeriodForScope } from "@/lib/payroll/periods";
import { isPayrollPeriodLocked } from "@/lib/payroll/period";
import { applyPeriodSales, attributedNetForCalc } from "@/lib/payroll/sales-attribution";
import { recomputeCalcAutomatic } from "@/lib/payroll/recompute";
import { rublesToKopeks } from "@/lib/money";

export type SalesActionState = { ok: boolean; error?: string; notice?: string };
const fail = (e: string): SalesActionState => ({ ok: false, error: e });

async function resolvePeriodScope(periodId: string) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false as const, error: "Нет доступа" };
  const companyId = ctx.selectedCompanyId;
  const clubIds = (await getUserClubs(ctx.user.id, companyId)).map((c) => c.id);
  const period = await getPeriodForScope(companyId, clubIds, periodId);
  if (!period) return { ok: false as const, error: "Период вне зоны доступа" };
  return { ok: true as const, ctx, companyId, clubIds, period };
}

/** Effective sales = manual override when set, else the automatic OFD net. */
function effectiveOf(automatic: number, manual: number | null): { effective: number; source: string } {
  if (manual != null) return { effective: manual, source: automatic !== 0 ? "mixed" : "manual" };
  return { effective: automatic, source: automatic !== 0 ? "ofd_confirmed" : "manual" };
}

/**
 * Apply OFD sales attribution to an OPEN period (spec §16/§17): write per-receipt attributions,
 * set each calc's automatic/effective sales snapshot, recompute from the role formula engine.
 * Manual overrides are preserved. Locked (approved/paid/closed) periods are NOT changed — a
 * separate issue is surfaced instead.
 */
export async function applyPeriodSalesAction(_prev: SalesActionState | undefined, formData: FormData): Promise<SalesActionState> {
  const periodId = String(formData.get("periodId") ?? "").trim();
  const scope = await resolvePeriodScope(periodId);
  if (!scope.ok) return fail(scope.error);
  if (!canManagePayrollAssignments(scope.ctx.effectiveRoles)) return fail("Недостаточно прав.");
  if (isPayrollPeriodLocked(scope.period.status)) return fail("Период согласован/закрыт — автоматическое обновление продаж отключено. Появление новых чеков — отдельная задача.");

  const { period, companyId } = scope;
  const calcs = await prisma.payrollCalculation.findMany({ where: { payrollPeriodId: period.id }, select: { id: true, employeeId: true, manualSalesOverrideKopeks: true } });
  const calcByEmployee = new Map(calcs.map((c) => [c.employeeId, c.id]));

  const net = await applyPeriodSales({ companyId, clubId: period.clubId, year: period.year, month: period.month, payrollPeriodId: period.id, calcByEmployee, assignedById: scope.ctx.user.id });

  const now = new Date();
  for (const c of calcs) {
    const automatic = net.get(c.employeeId) ?? (await attributedNetForCalc(c.id));
    const { effective, source } = effectiveOf(automatic, c.manualSalesOverrideKopeks);
    await prisma.payrollCalculation.update({ where: { id: c.id }, data: { automaticSalesKopeks: automatic, effectiveSalesKopeks: effective, salesSource: source, salesSyncedAt: now } });
    await recomputeCalcAutomatic(c.id, effective);
  }
  try {
    await recordAudit({ action: "payroll.sales_attribution_applied", entityType: "PayrollPeriod", entityId: period.id, companyId, clubId: period.clubId, userId: scope.ctx.user.id, metadata: { employees: net.size } });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/periods/${period.id}`);
  revalidatePath("/payroll");
  return { ok: true, notice: `Продажи из ОФД применены: ${net.size} сотр.` };
}

/** Set/replace a manual personal-sales override for a calc (never silently lost, spec §15). */
export async function setManualSalesOverride(_prev: SalesActionState | undefined, formData: FormData): Promise<SalesActionState> {
  const calculationId = String(formData.get("calculationId") ?? "").trim();
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: calculationId } });
  if (!calc) return fail("Расчёт не найден");
  const scope = await resolvePeriodScope(calc.payrollPeriodId);
  if (!scope.ok) return fail(scope.error);
  if (!canManagePayrollAssignments(scope.ctx.effectiveRoles)) return fail("Недостаточно прав.");
  if (isPayrollPeriodLocked(scope.period.status)) return fail("Период закрыт для изменений.");

  const raw = String(formData.get("manualSales") ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const clear = String(formData.get("clear") ?? "") === "1";
  const manual = clear || raw === "" ? null : rublesToKopeks(Number(raw));
  if (!clear && raw !== "" && (manual == null || !Number.isFinite(manual) || manual < 0)) return fail("Некорректная сумма.");
  const comment = String(formData.get("manualSalesComment") ?? "").trim() || null;
  const { effective, source } = effectiveOf(calc.automaticSalesKopeks, manual);
  await prisma.payrollCalculation.update({ where: { id: calc.id }, data: { manualSalesOverrideKopeks: manual, manualSalesComment: comment, effectiveSalesKopeks: effective, salesSource: source } });
  await recomputeCalcAutomatic(calc.id, effective);
  try {
    await recordAudit({ action: "payroll.sales_manual_override", entityType: "PayrollCalculation", entityId: calc.id, companyId: scope.companyId, clubId: calc.clubId, userId: scope.ctx.user.id, metadata: { manualKopeks: manual } });
  } catch {
    /* ignore */
  }
  revalidatePath(`/payroll/periods/${calc.payrollPeriodId}`);
  return { ok: true, notice: clear || manual == null ? "Ручная корректировка снята." : "Ручная выручка сохранена." };
}
