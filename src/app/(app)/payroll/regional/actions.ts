"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, canAccessClub, userHasCompanyRole, recordAudit } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { rublesToKopeks } from "@/lib/money";
import { getActiveClubLegalEntities } from "@/lib/legal-entities";
import { ensureClubCashWallet, ensureRegionalCashWallet } from "@/lib/cash-wallets";
import { canManagePaySchemes, canViewRegionalPayroll } from "@/lib/payroll/access";
import { regionalAccrual, regionalTotals, REGIONAL_BASE_TYPES } from "@/lib/payroll/regional";
import { createSalaryExpense, cancelSalaryExpense } from "@/lib/payroll/salary-expense";
import { paymentFingerprint } from "@/lib/payroll/payment-service";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

export type RegionalState = { ok: boolean; error?: string; notice?: string; id?: string };
const fail = (e: string): RegionalState => ({ ok: false, error: e });
const rub = (fd: FormData, n: string): number => {
  const raw = String(fd.get(n) ?? "").trim().replace(/\s/g, "").replace(",", ".");
  return raw === "" ? 0 : Math.max(0, Math.round(Number(raw) * 100) || 0);
};

async function scopeCityClubs(userId: string, companyId: string): Promise<Map<string, string[]>> {
  const clubs = await getUserClubs(userId, companyId);
  const byCity = new Map<string, string[]>();
  for (const c of clubs) {
    const city = c.city ?? "";
    if (!city) continue;
    byCity.set(city, [...(byCity.get(city) ?? []), c.id]);
  }
  return byCity;
}

/** Create / update the DRAFT city accrual (base + %). Owner approves it separately. */
export async function saveRegionalCityPayroll(_prev: RegionalState | undefined, formData: FormData): Promise<RegionalState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return fail("Нет доступа");
  if (!canManagePaySchemes(ctx.effectiveRoles)) return fail("Недостаточно прав");
  const companyId = ctx.selectedCompanyId;

  const city = String(formData.get("city") ?? "").trim();
  const cities = await scopeCityClubs(ctx.user.id, companyId);
  if (!city || !cities.has(city)) return fail("Город вне зоны доступа");
  const m = /^(\d{4})-(\d{2})$/.exec(String(formData.get("month") ?? "").trim());
  if (!m) return fail("Укажите месяц");
  const year = Number(m[1]); const month = Number(m[2]);
  const baseType = String(formData.get("baseType") ?? "").trim();
  if (!(REGIONAL_BASE_TYPES as readonly string[]).includes(baseType)) return fail("Выберите базу (выручка или прибыль)");
  const baseKopeks = rub(formData, "base");
  const percentBp = Math.max(0, Math.round(Number(String(formData.get("percent") ?? "").replace(",", ".")) * 100) || 0);
  const regionalName = String(formData.get("regionalName") ?? "").trim();
  if (!regionalName) return fail("Укажите ФИО регионала");
  const regionalEmployeeId = String(formData.get("regionalEmployeeId") ?? "").trim() || null;
  const accruedKopeks = regionalAccrual(baseKopeks, percentBp);

  const existing = await prisma.regionalCityPayroll.findFirst({ where: { companyId, city, year, month } });
  if (existing && existing.status === "approved") return fail("Расчёт по городу уже утверждён — редактирование недоступно");

  const row = await prisma.regionalCityPayroll.upsert({
    where: { companyId_city_year_month: { companyId, city, year, month } },
    create: { companyId, city, year, month, regionalEmployeeId, regionalName, baseType, baseKopeks, percentBp, accruedKopeks, status: "draft", createdByUserId: ctx.user.id },
    update: { regionalEmployeeId, regionalName, baseType, baseKopeks, percentBp, accruedKopeks },
  });
  try {
    await recordAudit({ action: "payroll.regional_saved", entityType: "RegionalCityPayroll", entityId: row.id, companyId, userId: ctx.user.id, metadata: { city, year, month, baseType, accruedKopeks } });
  } catch { /* ignore */ }
  revalidatePath("/payroll/regional");
  return { ok: true, id: row.id, notice: "Расчёт по городу сохранён (черновик)." };
}

/** Owner approves the scheme + %. Only then may payments go out. */
export async function approveRegionalCityPayroll(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const row = await prisma.regionalCityPayroll.findUnique({ where: { id } });
  if (!row || row.status !== "draft") return;
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || ctx.selectedCompanyId !== row.companyId) return;
  if (!(await userHasCompanyRole(ctx.user.id, row.companyId, ["owner"]))) return;
  await prisma.regionalCityPayroll.update({ where: { id }, data: { status: "approved", ownerApprovedById: ctx.user.id, ownerApprovedAt: new Date() } });
  try {
    await recordAudit({ action: "payroll.regional_approved", entityType: "RegionalCityPayroll", entityId: id, companyId: row.companyId, userId: ctx.user.id });
  } catch { /* ignore */ }
  revalidatePath("/payroll/regional");
}

/**
 * Record a part-payment to the regional from a SOURCE CLUB of the city. The club's cash
 * is reduced once (salary Expense). Total payments may NOT exceed the accrual unless
 * `allowOverpayment` is set — which then creates an explicit employee_owes_company debt
 * for the excess.
 */
export async function recordRegionalCityPayment(_prev: RegionalState | undefined, formData: FormData): Promise<RegionalState> {
  const payrollId = String(formData.get("regionalCityPayrollId") ?? "").trim();
  const row = await prisma.regionalCityPayroll.findUnique({ where: { id: payrollId } });
  if (!row) return fail("Расчёт по городу не найден");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || ctx.selectedCompanyId !== row.companyId) return fail("Нет доступа");
  if (row.status !== "approved") return fail("Выплата возможна только после утверждения собственником");
  const roles = ctx.effectiveRoles;
  // Regional payroll is off-limits to a club manager (§7/§16). Only the regional-payroll
  // band (owner/GD/regional/chief_accountant/accountant) may pay the regional's share.
  if (!canViewRegionalPayroll(roles)) return fail("Недостаточно прав");

  const clubId = String(formData.get("clubId") ?? "").trim();
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true, city: true } });
  if (!club || club.companyId !== row.companyId || club.city !== row.city) return fail("Клуб не относится к городу расчёта");
  if (!ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) return fail("Клуб недоступен");

  const method = String(formData.get("method") ?? "").trim();
  if (method !== "cash" && method !== "bank") return fail("Выберите способ выплаты");
  const amountKopeks = rub(formData, "amount");
  if (amountKopeks <= 0) return fail("Сумма должна быть больше нуля");
  const now = new Date();
  const closed = await monthClosedError(row.companyId, clubId, now);
  if (closed) return fail(closed);

  // Overpay guard: forbid total > accrued unless an explicit overpayment debt is created.
  const existingPayments = await prisma.regionalCityPayment.findMany({ where: { regionalCityPayrollId: payrollId, status: "confirmed" }, select: { amountKopeks: true } });
  const totals = regionalTotals(row.accruedKopeks, existingPayments);
  const newPaid = totals.paidKopeks + amountKopeks;
  const allowOverpayment = String(formData.get("allowOverpayment") ?? "") === "on";
  const excess = newPaid - row.accruedKopeks;
  if (excess > 0 && !allowOverpayment) {
    return fail("Суммарная выплата превышает начисление. Отметьте «оформить переплату долгом», чтобы продолжить.");
  }

  // Resolve legal entity + wallet of the SOURCE club (cash reduces that club's cash once).
  const { ooo, ip } = await getActiveClubLegalEntities(clubId);
  let legalEntityId: string; let walletId: string | null = null;
  if (method === "cash") {
    if (!ip) return fail("У клуба нет активного ИП для наличной выплаты.");
    const chosen = String(formData.get("legalEntityId") ?? "").trim();
    if (chosen && chosen !== ip.id) return fail("Наличная выплата возможна только из ИП.");
    legalEntityId = ip.id;
    walletId = roles.includes("regional_director") ? await ensureRegionalCashWallet(row.companyId, clubId, ip.id, ctx.user.id) : await ensureClubCashWallet(row.companyId, clubId, ip.id);
  } else {
    const chosen = String(formData.get("legalEntityId") ?? "").trim();
    const allowed = [ooo?.id, ip?.id].filter((x): x is string => Boolean(x));
    if (allowed.length === 0) return fail("У клуба нет активного юрлица для безналичной выплаты.");
    if (chosen && !allowed.includes(chosen)) return fail("Выбранное юрлицо не относится к клубу.");
    legalEntityId = chosen || (ooo?.id ?? ip!.id);
  }

  // REM-01: atomic + idempotent regional payout. The overpay check is RE-EVALUATED inside the tx
  // (closes the TOCTOU); RegionalCityPayment + salary Expense + cash movement + the optional
  // overpayment obligation commit all-or-nothing. Idempotency = DB-unique (companyId, idempotencyKey);
  // a same-key replay returns the existing payment. (RBAC + the regionalEmployeeId fallback semantics
  // are unchanged — DATA-010 remains a separate follow-up.)
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim() || `srv:${randomUUID()}`;
  const fingerprint = paymentFingerprint({ companyId: row.companyId, paymentType: "regional", sourceType: method, payrollCalculationId: payrollId, employeeId: row.regionalEmployeeId ?? payrollId, legalEntityId, amountKopeks, method });
  let replayed = false;
  let paymentId = "";
  try {
    await prisma.$transaction(async (tx) => {
      const dup = await tx.regionalCityPayment.findUnique({ where: { companyId_idempotencyKey: { companyId: row.companyId, idempotencyKey } }, select: { id: true, requestFingerprint: true } });
      if (dup) {
        if (dup.requestFingerprint && dup.requestFingerprint !== fingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
        paymentId = dup.id; replayed = true; return;
      }
      // Re-check overpay against CONFIRMED payments inside the tx (authoritative).
      const confirmedNow = await tx.regionalCityPayment.findMany({ where: { regionalCityPayrollId: payrollId, status: "confirmed" }, select: { amountKopeks: true } });
      const paidNow = regionalTotals(row.accruedKopeks, confirmedNow).paidKopeks;
      const excessNow = paidNow + amountKopeks - row.accruedKopeks;
      if (excessNow > 0 && !allowOverpayment) throw new Error("EXCEEDS");
      const payment = await tx.regionalCityPayment.create({
        data: {
          companyId: row.companyId, regionalCityPayrollId: payrollId, clubId, legalEntityId, amountKopeks, paymentMethod: method,
          sourceType: method === "cash" ? (roles.includes("regional_director") ? "regional_cash" : "club_cash") : "bank_account",
          status: "confirmed", paidByUserId: ctx.user.id, idempotencyKey, requestFingerprint: fingerprint,
        },
      });
      const { expenseId } = await createSalaryExpense({
        companyId: row.companyId, clubId, legalEntityId, method: method as "cash" | "bank", amountKopeks, paidByUserId: ctx.user.id,
        cashWalletId: walletId, employeeId: row.regionalEmployeeId ?? payrollId, employeeName: `Регионал ${row.regionalName} (${row.city})`, payrollPeriodId: null, kind: "payment",
      }, tx);
      await tx.regionalCityPayment.update({ where: { id: payment.id }, data: { expenseId } });
      if (excessNow > 0 && allowOverpayment) {
        await tx.employeeFinancialObligation.create({
          data: { companyId: row.companyId, employeeId: row.regionalEmployeeId ?? payrollId, clubId, direction: "employee_owes_company", reason: "overpayment", originalAmountKopeks: excessNow, outstandingAmountKopeks: excessNow, status: "open", createdByUserId: ctx.user.id },
        });
      }
      paymentId = payment.id;
    }, { timeout: 15_000, maxWait: 10_000 });
  } catch (e) {
    if (e instanceof Error && e.message === "EXCEEDS") return fail("Суммарная выплата превышает начисление. Отметьте «оформить переплату долгом», чтобы продолжить.");
    if (e instanceof Error && e.message === "IDEMPOTENCY_CONFLICT") return fail("Эта операция уже выполнена с другими параметрами. Обновите страницу.");
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") { revalidatePath("/payroll/regional"); return { ok: true, notice: "Выплата уже проведена." }; }
    console.error("recordRegionalCityPayment failed", e instanceof Error ? e.message : e);
    return fail("Не удалось провести выплату. Повторите попытку.");
  }
  try {
    await recordAudit({ action: replayed ? "payroll.regional_payment_replayed" : "payroll.regional_payment", entityType: "RegionalCityPayroll", entityId: payrollId, companyId: row.companyId, clubId, userId: ctx.user.id, metadata: { paymentId, method, amountKopeks, overpayKopeks: excess > 0 ? excess : 0, replayed } });
  } catch { /* ignore */ }
  revalidatePath("/payroll/regional");
  return { ok: true, notice: excess > 0 ? "Выплата проведена; переплата оформлена долгом сотрудника." : "Выплата проведена." };
}

/** Cancel a regional part-payment (reverse the salary expense). */
export async function cancelRegionalCityPayment(formData: FormData): Promise<void> {
  const paymentId = String(formData.get("paymentId") ?? "").trim();
  if (!paymentId) return;
  const payment = await prisma.regionalCityPayment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.status !== "confirmed") return;
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || ctx.selectedCompanyId !== payment.companyId) return;
  // Managers cannot touch regional payroll (§7/§16) — even to cancel a payment.
  if (!canViewRegionalPayroll(ctx.effectiveRoles)) return;
  if (!(await canAccessClub(ctx.user.id, payment.clubId))) return;
  await cancelSalaryExpense(payment.expenseId, ctx.user.id, "Отмена выплаты регионалу");
  await prisma.regionalCityPayment.update({ where: { id: paymentId }, data: { status: "canceled" } });
  try {
    await recordAudit({ action: "payroll.regional_payment_canceled", entityType: "RegionalCityPayment", entityId: paymentId, companyId: payment.companyId, clubId: payment.clubId, userId: ctx.user.id });
  } catch { /* ignore */ }
  revalidatePath("/payroll/regional");
}
