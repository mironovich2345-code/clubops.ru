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
import { advanceApprovedKopeks, trancheExceedsApproved } from "@/lib/payroll/advance-tranche-calc";
import { isPayrollPeriodClosed } from "@/lib/payroll/period";

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
  // REM-01: atomic payout — salary Expense (+cash) + advance status + calc recompute all-or-nothing.
  await prisma.$transaction(async (tx) => {
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
    }, tx);
    await tx.payrollAdvance.update({ where: { id: advanceId }, data: { status: "paid", paidByUserId: params.userId, paidAt: new Date(), expenseId } });
    if (calc) await recomputeCalculationTotals(calc.id, tx); // fold into remaining; no repeat expense
  }, { timeout: 15_000, maxWait: 10_000 });
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
      amountKopeks, requestedAmountKopeks: amountKopeks, approvedAmountKopeks: amountKopeks, paymentMethod: method,
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
  revalidatePath("/payroll/advances");
  revalidatePath("/payroll");
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
  revalidatePath("/payroll/advances");
  revalidatePath("/payroll");
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
  revalidatePath("/payroll/advances");
  revalidatePath("/payroll");
}

// ============================ STAGE 9: tranches ==============================

const revalidateAdvance = (id: string) => { revalidatePath(`/payroll/advances/${id}`); revalidatePath("/payroll/advances"); revalidatePath("/payroll"); };

/** Sum of ACTIVE (non-reversed) tranche amounts for an advance. */
async function activePaidKopeks(advanceId: string, tx: typeof prisma = prisma): Promise<number> {
  const rows = await tx.payrollAdvancePayment.findMany({ where: { employeeAdvanceId: advanceId, status: "paid" }, select: { amountKopeks: true } });
  return rows.reduce((s, r) => s + r.amountKopeks, 0);
}

/** Create an APPROVED (not yet paid) advance — the entry point for the tranche model.
 * No money moves at approval (spec §9). Tranches pay it later. One per employee+month. */
export async function createApprovedAdvance(_prev: AdvanceState | undefined, formData: FormData): Promise<AdvanceState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return fail("Нет доступа");
  if (!canManagePayrollAssignments(ctx.effectiveRoles)) return fail("Недостаточно прав");
  const companyId = ctx.selectedCompanyId;
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) return fail("Клуб недоступен");
  if (!(await getEmployeeForScope(companyId, ctx.allowedClubIds, employeeId))) return fail("Сотрудник вне зоны доступа");
  const now = new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(String(formData.get("month") ?? "").trim());
  const year = m ? Number(m[1]) : now.getFullYear();
  const month = m ? Number(m[2]) : now.getMonth() + 1;
  if (await monthClosedError(companyId, clubId, new Date(year, month - 1, 1))) return fail("Месяц закрыт");
  const approved = rub(formData, "approvedAmount");
  const earnedToDate = rub(formData, "earnedToDate");
  const comment = String(formData.get("comment") ?? "").trim() || null;
  if (approved <= 0) return fail("Укажите согласованную сумму аванса.");
  if (earnedToDate <= 0) return fail("Укажите заработанную к дате сумму.");
  if (!advanceWithinEarned(approved, earnedToDate)) return fail("Согласованная сумма не может превышать заработанное к дате.");

  const dup = await prisma.payrollAdvance.findFirst({ where: { employeeId, clubId, periodYear: year, periodMonth: month, status: { in: ["paid", "approved", "requested"] } }, select: { id: true } });
  if (dup) return { ok: false, error: "Аванс за этот месяц уже существует — откройте его для добавления выплат.", notice: dup.id };

  const adv = await prisma.payrollAdvance.create({
    data: { companyId, employeeId, clubId, periodYear: year, periodMonth: month, earnedToDateKopeks: earnedToDate, earnedToDateSource: "manual", amountKopeks: approved, requestedAmountKopeks: approved, approvedAmountKopeks: approved, comment, status: "approved", approvedByUserId: ctx.user.id },
  });
  try { await recordAudit({ action: "payroll.advance_approved_amount", entityType: "PayrollAdvance", entityId: adv.id, companyId, clubId, userId: ctx.user.id, metadata: { approvedAmountKopeks: approved } }); } catch { /* ignore */ }
  revalidateAdvance(adv.id);
  return { ok: true, notice: adv.id };
}

/** Increase the approved amount of an advance (spec §7). Re-approval by owner/GD/regional;
 * already-paid tranches are kept; history is audited. */
export async function increaseApprovedAmount(_prev: AdvanceState | undefined, formData: FormData): Promise<AdvanceState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return fail("Нет доступа");
  const advanceId = String(formData.get("advanceId") ?? "").trim();
  const adv = await prisma.payrollAdvance.findUnique({ where: { id: advanceId } });
  if (!adv || adv.companyId !== ctx.selectedCompanyId) return fail("Аванс не найден");
  if (!(await canAccessClub(ctx.user.id, adv.clubId))) return fail("Клуб недоступен");
  const isApprover = ctx.effectiveRoles.some((r) => r === "regional_director" || r === "general_director" || r === "owner");
  if (!isApprover) return fail("Увеличение согласованной суммы утверждает регионал/ГД/собственник.");
  const newApproved = rub(formData, "approvedAmount");
  const oldApproved = advanceApprovedKopeks(adv);
  if (newApproved <= oldApproved) return fail("Новая сумма должна быть больше текущей согласованной.");
  if (!advanceWithinEarned(newApproved, adv.earnedToDateKopeks)) return fail("Согласованная сумма не может превышать заработанное к дате.");
  await prisma.payrollAdvance.update({ where: { id: adv.id }, data: { approvedAmountKopeks: newApproved, status: adv.status === "canceled" || adv.status === "rejected" ? adv.status : "approved" } });
  try { await recordAudit({ action: "payroll.advance_approved_amount", entityType: "PayrollAdvance", entityId: adv.id, companyId: adv.companyId, clubId: adv.clubId, userId: ctx.user.id, metadata: { oldApprovedKopeks: oldApproved, newApprovedKopeks: newApproved } }); } catch { /* ignore */ }
  revalidateAdvance(adv.id);
  return { ok: true, notice: "Согласованная сумма увеличена." };
}

/** Pay a TRANCHE against an approved advance. One money movement per tranche; idempotent
 * by idempotencyKey; the approved amount can never be exceeded (checked inside a
 * transaction so concurrent tranches cannot overspend). Refuses on a legacy single-payout
 * advance (has a top-level expenseId and no tranches) — that money model is disjoint. */
export async function addAdvanceTranche(_prev: AdvanceState | undefined, formData: FormData): Promise<AdvanceState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return fail("Нет доступа");
  const roles = ctx.effectiveRoles;
  const advanceId = String(formData.get("advanceId") ?? "").trim();
  const adv = await prisma.payrollAdvance.findUnique({ where: { id: advanceId } });
  if (!adv || adv.companyId !== ctx.selectedCompanyId) return fail("Аванс не найден");
  if (!(await canAccessClub(ctx.user.id, adv.clubId))) return fail("Клуб недоступен");
  if (adv.status === "canceled" || adv.status === "rejected" || adv.status === "requested") return fail("Аванс не согласован для выплаты.");

  const method = String(formData.get("method") ?? "").trim();
  if (method !== "cash" && method !== "bank") return fail("Выберите способ выплаты");
  if (method === "cash" && !isOperational(roles)) return fail("Наличную выплату проводит управляющий или регионал");
  if (method === "bank" && !isAccounting(roles)) return fail("Безналичную выплату проводит бухгалтер");
  if (await monthClosedError(adv.companyId, adv.clubId, new Date(adv.periodYear, adv.periodMonth - 1, 1))) return fail("Месяц закрыт");

  const existingWithLegacy = adv.expenseId && (await prisma.payrollAdvancePayment.count({ where: { employeeAdvanceId: adv.id } })) === 0;
  if (existingWithLegacy) return fail("Этот аванс выплачен единым платежом (legacy). Транши доступны для авансов, созданных как «Согласовать сумму», или после переноса backfill.");

  const amountKopeks = rub(formData, "amount");
  if (amountKopeks <= 0) return fail("Укажите сумму транша.");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim();
  if (!idempotencyKey) return fail("Отсутствует ключ идемпотентности.");
  const already = await prisma.payrollAdvancePayment.findUnique({ where: { idempotencyKey } });
  if (already) { revalidateAdvance(adv.id); return { ok: true, notice: "Выплата уже проведена." }; }

  const le = await resolveLegalEntity(adv.companyId, adv.clubId, ctx.user.id, method, roles);
  if ("error" in le) return fail(le.error);
  const approved = advanceApprovedKopeks(adv);
  const employeeName = (await prisma.clubEmployee.findUnique({ where: { id: adv.employeeId }, select: { fullName: true } }))?.fullName ?? adv.employeeId;

  try {
    await prisma.$transaction(async (tx) => {
      const paidNow = await activePaidKopeks(adv.id, tx as unknown as typeof prisma);
      if (trancheExceedsApproved(approved, paidNow, amountKopeks)) throw new Error("EXCEEDS");
      // REM-01: pass tx so the Expense + CashMovement commit INSIDE this transaction (previously they
      // ran on the global client and could orphan if the tranche rows rolled back).
      const { expenseId } = await createSalaryExpense({
        companyId: adv.companyId, clubId: adv.clubId, legalEntityId: le.legalEntityId, method: method as "cash" | "bank",
        amountKopeks, paidByUserId: ctx.user.id, cashWalletId: le.walletId, employeeId: adv.employeeId, employeeName,
        payrollPeriodId: null, kind: "advance",
      }, tx);
      const cashMovement = method === "cash" ? await tx.cashMovement.findFirst({ where: { sourceType: "expense", sourceId: expenseId }, select: { id: true } }) : null;
      await tx.payrollAdvancePayment.create({
        data: { companyId: adv.companyId, clubId: adv.clubId, employeeAdvanceId: adv.id, amountKopeks, paymentMethod: method, legalEntityId: le.legalEntityId, cashSource: method === "cash" ? (roles.includes("regional_director") ? "regional_cash" : "club_cash") : null, expenseId, cashMovementId: cashMovement?.id ?? null, status: "paid", createdByUserId: ctx.user.id, idempotencyKey },
      });
      await tx.payrollAdvance.update({ where: { id: adv.id }, data: { status: "paid", paidByUserId: ctx.user.id, paidAt: new Date() } });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "EXCEEDS") return fail("Сумма траншей превысила бы согласованную сумму аванса.");
    if (e instanceof Error && /Unique|P2002/.test(e.message)) { revalidateAdvance(adv.id); return { ok: true, notice: "Выплата уже проведена." }; }
    console.error("addAdvanceTranche failed", e instanceof Error ? e.message : e);
    return fail("Не удалось провести выплату. Повторите попытку.");
  }

  const calc = await findMonthCalc(adv.companyId, adv.clubId, adv.employeeId, adv.periodYear, adv.periodMonth);
  if (calc) { await prisma.payrollAdvance.update({ where: { id: adv.id }, data: { linkedPayrollCalculationId: calc.id } }); await recomputeCalculationTotals(calc.id); }
  try { await recordAudit({ action: "payroll.advance_tranche_paid", entityType: "PayrollAdvance", entityId: adv.id, companyId: adv.companyId, clubId: adv.clubId, userId: ctx.user.id, metadata: { amountKopeks, method } }); } catch { /* ignore */ }
  revalidateAdvance(adv.id);
  return { ok: true, notice: "Выплата проведена." };
}

/** Storno ONE tranche (spec §12): reverse the cash once, mark reversed, recompute. The
 * tranche row is kept (history). Blocked if the period is closed. Idempotent. */
export async function reverseAdvanceTranche(_prev: AdvanceState | undefined, formData: FormData): Promise<AdvanceState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return fail("Нет доступа");
  const trancheId = String(formData.get("trancheId") ?? "").trim();
  const tr = await prisma.payrollAdvancePayment.findUnique({ where: { id: trancheId } });
  if (!tr || tr.companyId !== ctx.selectedCompanyId) return fail("Транш не найден");
  const adv = await prisma.payrollAdvance.findUnique({ where: { id: tr.employeeAdvanceId } });
  if (!adv) return fail("Аванс не найден");
  if (!(await canAccessClub(ctx.user.id, adv.clubId))) return fail("Клуб недоступен");
  const roles = ctx.effectiveRoles;
  const canReverse = tr.paymentMethod === "cash" ? isOperational(roles) : isAccounting(roles);
  if (!canReverse && !roles.some((r) => r === "general_director" || r === "owner")) return fail("Недостаточно прав для сторно.");
  if (tr.status !== "paid") { revalidateAdvance(adv.id); return { ok: true, notice: "Транш уже сторнирован." }; }

  // Closed-period guard: never silently change a closed period.
  const calc = await findMonthCalc(adv.companyId, adv.clubId, adv.employeeId, adv.periodYear, adv.periodMonth);
  if (calc) {
    const period = await prisma.payrollPeriod.findUnique({ where: { id: calc.payrollPeriodId }, select: { status: true } });
    if (period && isPayrollPeriodClosed(period.status)) return fail("Период закрыт — прямое сторно запрещено. Оформите корректировку следующего периода.");
  }
  if (await monthClosedError(adv.companyId, adv.clubId, new Date(adv.periodYear, adv.periodMonth - 1, 1))) return fail("Месяц закрыт.");

  const reason = String(formData.get("reason") ?? "").trim() || "Сторно транша";
  await cancelSalaryExpense(tr.expenseId, ctx.user.id, reason); // reverses the cash once; idempotent inside
  await prisma.payrollAdvancePayment.update({ where: { id: tr.id }, data: { status: "reversed", reversedAt: new Date(), reversedByUserId: ctx.user.id, reversalReason: reason } });
  if (calc) await recomputeCalculationTotals(calc.id);
  try { await recordAudit({ action: "payroll.advance_tranche_reversed", entityType: "PayrollAdvancePayment", entityId: tr.id, companyId: adv.companyId, clubId: adv.clubId, userId: ctx.user.id, metadata: { amountKopeks: tr.amountKopeks } }); } catch { /* ignore */ }
  revalidateAdvance(adv.id);
  return { ok: true, notice: "Транш сторнирован." };
}
