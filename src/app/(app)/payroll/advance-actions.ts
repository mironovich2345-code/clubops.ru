"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, canAccessClub, recordAudit } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { rublesToKopeks } from "@/lib/money";
import { resolveActiveIpForClub } from "@/lib/expense-simplified";
import { getActiveClubLegalEntities } from "@/lib/legal-entities";
import { ensureClubCashWallet, ensureRegionalCashWallet } from "@/lib/cash-wallets";
import { getEmployeeForScope } from "@/lib/club-employees";
import { canManagePayrollAssignments } from "@/lib/payroll/access";
import { advanceWithinEarned } from "@/lib/payroll/payments";
import { createSalaryExpense, cancelSalaryExpense } from "@/lib/payroll/salary-expense";
import { recomputeCalculationTotals } from "@/lib/payroll/aggregate";

export type AdvanceState = { ok: boolean; error?: string; notice?: string };
const fail = (e: string): AdvanceState => ({ ok: false, error: e });
const rub = (fd: FormData, n: string): number => {
  const raw = String(fd.get(n) ?? "").trim().replace(/\s/g, "").replace(",", ".");
  return raw === "" ? 0 : Math.max(0, Math.round(Number(raw) * 100) || 0);
};

const isRegional = (roles: readonly string[]) => roles.some((r) => r === "regional_director");
const isOperational = (roles: readonly string[]) => roles.some((r) => r === "manager" || r === "regional_director");
const isAccounting = (roles: readonly string[]) => roles.some((r) => r === "accountant" || r === "chief_accountant");

/** The calculation for an employee's month, if a period + calc already exist. */
async function findMonthCalc(companyId: string, clubId: string, employeeId: string, year: number, month: number) {
  const period = await prisma.payrollPeriod.findFirst({ where: { companyId, clubId, year, month }, select: { id: true } });
  if (!period) return null;
  return prisma.payrollCalculation.findFirst({ where: { payrollPeriodId: period.id, employeeId } });
}

async function resolveLegalEntity(companyId: string, clubId: string, userId: string, method: string, roles: readonly string[]): Promise<{ legalEntityId: string; walletId: string | null } | { error: string }> {
  if (method === "cash") {
    const ip = await resolveActiveIpForClub(clubId);
    if (!ip.ok) return { error: ip.error };
    const walletId = roles.includes("regional_director")
      ? await ensureRegionalCashWallet(companyId, clubId, ip.legalEntityId, userId)
      : await ensureClubCashWallet(companyId, clubId, ip.legalEntityId);
    return { legalEntityId: ip.legalEntityId, walletId };
  }
  const { ooo, ip } = await getActiveClubLegalEntities(clubId);
  const le = ooo?.id ?? ip?.id ?? null;
  if (!le) return { error: "Не удалось определить юрлицо для безналичного аванса." };
  return { legalEntityId: le, walletId: null };
}

/** Pay out an advance: salary Expense (+cash movement) + link + recompute any calc. */
async function payoutAdvance(advanceId: string, params: { companyId: string; clubId: string; employeeId: string; amountKopeks: number; method: string; legalEntityId: string; walletId: string | null; userId: string; year: number; month: number }): Promise<void> {
  const employeeName = (await prisma.clubEmployee.findUnique({ where: { id: params.employeeId }, select: { fullName: true } }))?.fullName ?? params.employeeId;
  const calc = await findMonthCalc(params.companyId, params.clubId, params.employeeId, params.year, params.month);
  const { expenseId } = await createSalaryExpense({
    companyId: params.companyId,
    clubId: params.clubId,
    legalEntityId: params.legalEntityId,
    method: params.method as "cash" | "bank",
    amountKopeks: params.amountKopeks,
    paidByUserId: params.userId,
    cashWalletId: params.walletId,
    employeeId: params.employeeId,
    employeeName,
    payrollPeriodId: calc?.payrollPeriodId ?? null,
    kind: "advance",
  });
  await prisma.payrollAdvance.update({ where: { id: advanceId }, data: { status: "paid", paidByUserId: params.userId, paidAt: new Date(), expenseId } });
  if (calc) await recomputeCalculationTotals(calc.id); // fold into remaining; no repeat expense
}

/**
 * Record an advance in the OPEN current month — BEFORE a PayrollPeriod exists or is
 * approved. earnedToDate is the calc's net payable when available, else a MANUAL value
 * that requires a comment; a manual advance entered by a manager is «requested» until a
 * regional director approves it (only then does the money go out). Regional/auto → paid.
 */
export async function recordEmployeeAdvance(_prev: AdvanceState | undefined, formData: FormData): Promise<AdvanceState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return fail("Нет доступа");
  if (!canManagePayrollAssignments(ctx.effectiveRoles)) return fail("Недостаточно прав");
  const companyId = ctx.selectedCompanyId;
  const roles = ctx.effectiveRoles;

  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) return fail("Клуб недоступен");
  const employee = await getEmployeeForScope(companyId, ctx.allowedClubIds, employeeId);
  if (!employee) return fail("Сотрудник вне зоны доступа");

  const now = new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(String(formData.get("month") ?? "").trim());
  const year = m ? Number(m[1]) : now.getFullYear();
  const month = m ? Number(m[2]) : now.getMonth() + 1;
  const firstDay = new Date(year, month - 1, 1);
  const closed = await monthClosedError(companyId, clubId, firstDay);
  if (closed) return fail(closed);

  const method = String(formData.get("method") ?? "").trim();
  if (method !== "cash" && method !== "bank") return fail("Выберите способ выплаты");
  if (method === "cash" && !isOperational(roles)) return fail("Наличный аванс проводит управляющий или регионал");
  if (method === "bank" && !isAccounting(roles)) return fail("Безналичный аванс проводит бухгалтер");

  const dup = await prisma.payrollAdvance.findFirst({ where: { employeeId, clubId, periodYear: year, periodMonth: month, status: { in: ["paid", "approved", "requested"] } }, select: { id: true } });
  if (dup) return fail("Аванс за этот месяц уже оформлен");

  const amountKopeks = rub(formData, "amount");
  const comment = String(formData.get("comment") ?? "").trim() || null;

  // Auto base from the calc if one exists with computed pay; otherwise manual.
  const calc = await findMonthCalc(companyId, clubId, employeeId, year, month);
  let earnedToDate: number;
  let earnedSource: "auto" | "manual";
  if (calc && calc.netPayableKopeks > 0) {
    earnedToDate = calc.netPayableKopeks;
    earnedSource = "auto";
  } else {
    earnedToDate = rub(formData, "earnedToDate");
    earnedSource = "manual";
    if (earnedToDate <= 0) return fail("Расчёт за месяц ещё не готов — укажите заработанную к дате сумму вручную.");
    if (!comment) return fail("Ручная заработанная сумма требует комментарий.");
  }
  if (!advanceWithinEarned(amountKopeks, earnedToDate)) return fail("Аванс должен быть больше нуля и не превышать заработанное к дате.");

  const le = await resolveLegalEntity(companyId, clubId, ctx.user.id, method, roles);
  if ("error" in le) return fail(le.error);

  // Manual base entered by a manager → requires regional approval before payout.
  const needsRegionalApproval = earnedSource === "manual" && !isRegional(roles);

  const advance = await prisma.payrollAdvance.create({
    data: {
      companyId, employeeId, clubId, periodYear: year, periodMonth: month,
      earnedToDateKopeks: earnedToDate, earnedToDateSource: earnedSource,
      amountKopeks, paymentMethod: method,
      cashSource: method === "cash" ? (roles.includes("regional_director") ? "regional_cash" : "club_cash") : null,
      legalEntityId: le.legalEntityId, source: roles.includes("regional_director") ? "regional" : "other",
      comment, status: needsRegionalApproval ? "requested" : "paid",
      approvedByUserId: needsRegionalApproval ? null : ctx.user.id,
    },
  });

  if (!needsRegionalApproval) {
    await payoutAdvance(advance.id, { companyId, clubId, employeeId, amountKopeks, method, legalEntityId: le.legalEntityId, walletId: le.walletId, userId: ctx.user.id, year, month });
  }
  try {
    await recordAudit({ action: "payroll.advance_recorded", entityType: "PayrollAdvance", entityId: advance.id, companyId, clubId, userId: ctx.user.id, metadata: { amountKopeks, method, earnedSource, status: needsRegionalApproval ? "requested" : "paid" } });
  } catch { /* ignore */ }
  revalidatePath(`/payroll/employees/${employeeId}`);
  return { ok: true, notice: needsRegionalApproval ? "Аванс отправлен на подтверждение региональному директору." : "Аванс выдан." };
}

/** Regional director approves a «requested» manual advance → money goes out. */
export async function approveEmployeeAdvance(formData: FormData): Promise<void> {
  const advanceId = String(formData.get("advanceId") ?? "").trim();
  if (!advanceId) return;
  const advance = await prisma.payrollAdvance.findUnique({ where: { id: advanceId } });
  if (!advance || advance.status !== "requested") return;
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || ctx.selectedCompanyId !== advance.companyId) return;
  if (!isRegional(ctx.effectiveRoles) || !(await canAccessClub(ctx.user.id, advance.clubId))) return;
  const closed = await monthClosedError(advance.companyId, advance.clubId, new Date());
  if (closed) return;

  const le = await resolveLegalEntity(advance.companyId, advance.clubId, ctx.user.id, advance.paymentMethod ?? "cash", ctx.effectiveRoles);
  if ("error" in le) return;
  await prisma.payrollAdvance.update({ where: { id: advance.id }, data: { approvedByUserId: ctx.user.id } });
  await payoutAdvance(advance.id, { companyId: advance.companyId, clubId: advance.clubId, employeeId: advance.employeeId, amountKopeks: advance.amountKopeks, method: advance.paymentMethod ?? "cash", legalEntityId: le.legalEntityId, walletId: le.walletId, userId: ctx.user.id, year: advance.periodYear, month: advance.periodMonth });
  try {
    await recordAudit({ action: "payroll.advance_approved", entityType: "PayrollAdvance", entityId: advance.id, companyId: advance.companyId, clubId: advance.clubId, userId: ctx.user.id });
  } catch { /* ignore */ }
  revalidatePath(`/payroll/employees/${advance.employeeId}`);
}

/** Cancel a pre-period advance (requested → just cancel; paid → reverse the salary expense). */
export async function cancelEmployeeAdvance(formData: FormData): Promise<void> {
  const advanceId = String(formData.get("advanceId") ?? "").trim();
  if (!advanceId) return;
  const advance = await prisma.payrollAdvance.findUnique({ where: { id: advanceId } });
  if (!advance || !["requested", "approved", "paid"].includes(advance.status)) return;
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || ctx.selectedCompanyId !== advance.companyId) return;
  if (!canManagePayrollAssignments(ctx.effectiveRoles) || !(await canAccessClub(ctx.user.id, advance.clubId))) return;

  if (advance.status === "paid") {
    await cancelSalaryExpense(advance.expenseId, ctx.user.id, "Отмена аванса");
  }
  await prisma.payrollAdvance.update({ where: { id: advance.id }, data: { status: "canceled" } });
  const calc = await findMonthCalc(advance.companyId, advance.clubId, advance.employeeId, advance.periodYear, advance.periodMonth);
  if (calc) await recomputeCalculationTotals(calc.id);
  try {
    await recordAudit({ action: "payroll.advance_canceled", entityType: "PayrollAdvance", entityId: advance.id, companyId: advance.companyId, clubId: advance.clubId, userId: ctx.user.id });
  } catch { /* ignore */ }
  revalidatePath(`/payroll/employees/${advance.employeeId}`);
}
