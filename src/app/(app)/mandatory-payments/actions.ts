"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canManageMandatoryPayments } from "@/lib/auth";
import { getCurrentAccessContext, canAccessClub, recordAudit } from "@/lib/access";
import { rublesToKopeks } from "@/lib/money";
import { MANDATORY_CATEGORY_KEYS, isValidRecurrence } from "@/lib/mandatory-payments";

type State = { ok: boolean; error?: string };

const MANAGE_DENIED = "Управлять обязательными платежами может собственник или ген.директор";

function parseDay(v: string): Date | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** Manage gate shared by all actions: owner / general director, with company scope. */
async function requireManage() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { error: "Нет доступа" as const };
  if (!canManageMandatoryPayments(ctx.effectiveRoles)) return { error: MANAGE_DENIED };
  return { ctx, companyId: ctx.selectedCompanyId };
}

export async function createOrUpdateMandatoryPayment(
  _prev: State | undefined,
  formData: FormData,
): Promise<State> {
  const g = await requireManage();
  if ("error" in g) return { ok: false, error: g.error };
  const { ctx, companyId } = g;

  const id = String(formData.get("id") ?? "").trim();
  const clubId = String(formData.get("clubId") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const recurrence = String(formData.get("recurrence") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const dueDayRaw = String(formData.get("dueDayOfMonth") ?? "").trim();
  const dueDateRaw = String(formData.get("dueDate") ?? "").trim();
  const responsibleUserId = String(formData.get("responsibleUserId") ?? "").trim() || null;
  const legalEntityId = String(formData.get("legalEntityId") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  if (!club || club.companyId !== companyId) return { ok: false, error: "Клуб не найден" };
  if (!MANDATORY_CATEGORY_KEYS.has(category)) return { ok: false, error: "Неверная категория" };
  if (!title) return { ok: false, error: "Укажите название" };
  if (!isValidRecurrence(recurrence)) return { ok: false, error: "Неверный тип повтора" };

  const amount = amountRaw === "" ? NaN : Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: "Сумма должна быть неотрицательной" };
  const amountKopeks = rublesToKopeks(amount);

  let dueDayOfMonth: number | null = null;
  let dueDate: Date | null = null;
  if (recurrence === "monthly") {
    const d = Number(dueDayRaw);
    if (!Number.isInteger(d) || d < 1 || d > 31) return { ok: false, error: "Укажите день оплаты (1–31)" };
    dueDayOfMonth = d;
  } else {
    dueDate = parseDay(dueDateRaw);
    if (!dueDate) return { ok: false, error: "Укажите дату оплаты" };
  }

  if (responsibleUserId) {
    const inCompany = await prisma.companyUserAccess.findFirst({ where: { companyId, userId: responsibleUserId }, select: { id: true } });
    const inClub = inCompany ? null : await prisma.clubUserAccess.findFirst({ where: { userId: responsibleUserId, club: { companyId } }, select: { id: true } });
    if (!inCompany && !inClub) return { ok: false, error: "Ответственный не найден в компании" };
  }
  // Legal entity (which pays this) is optional, but if set it must belong to this company.
  if (legalEntityId) {
    const ent = await prisma.legalEntity.findUnique({ where: { id: legalEntityId }, select: { companyId: true } });
    if (!ent || ent.companyId !== companyId) return { ok: false, error: "Юрлицо не найдено" };
  }

  if (id) {
    const existing = await prisma.mandatoryPaymentPlan.findUnique({ where: { id }, select: { companyId: true, clubId: true } });
    if (!existing || existing.companyId !== companyId || !ctx.allowedClubIds.includes(existing.clubId)) {
      return { ok: false, error: "Платёж не найден" };
    }
    await prisma.mandatoryPaymentPlan.update({
      where: { id },
      data: { clubId, category, title, amountKopeks, recurrence, dueDayOfMonth, dueDate, responsibleUserId, legalEntityId, notes },
    });
    await recordAudit({
      action: "mandatory_payment.updated",
      entityType: "MandatoryPaymentPlan",
      entityId: id,
      companyId,
      clubId,
      userId: ctx.user.id,
      metadata: { category, amountKopeks, recurrence },
    });
  } else {
    const created = await prisma.mandatoryPaymentPlan.create({
      data: { companyId, clubId, category, title, amountKopeks, recurrence, dueDayOfMonth, dueDate, responsibleUserId, legalEntityId, notes, status: "planned", isActive: true, createdByUserId: ctx.user.id },
    });
    await recordAudit({
      action: "mandatory_payment.created",
      entityType: "MandatoryPaymentPlan",
      entityId: created.id,
      companyId,
      clubId,
      userId: ctx.user.id,
      metadata: { category, amountKopeks, recurrence },
    });
  }

  revalidatePath("/mandatory-payments");
  revalidatePath("/payments");
  return { ok: true };
}

/** Status change shared by pause / activate / cancel (never hard-deletes). */
async function changeStatus(formData: FormData, status: "planned" | "paused" | "canceled", isActive: boolean, action: string): Promise<void> {
  const g = await requireManage();
  if ("error" in g) throw new Error(g.error);
  const { ctx, companyId } = g;
  const id = String(formData.get("id") ?? "").trim();
  const existing = await prisma.mandatoryPaymentPlan.findUnique({ where: { id }, select: { companyId: true, clubId: true } });
  if (!existing || existing.companyId !== companyId || !ctx.allowedClubIds.includes(existing.clubId)) {
    throw new Error("Платёж не найден");
  }
  await prisma.mandatoryPaymentPlan.update({ where: { id }, data: { status, isActive } });
  await recordAudit({ action, entityType: "MandatoryPaymentPlan", entityId: id, companyId, clubId: existing.clubId, userId: ctx.user.id });
  revalidatePath("/mandatory-payments");
  revalidatePath("/payments");
}

export async function pauseMandatoryPayment(formData: FormData): Promise<void> {
  await changeStatus(formData, "paused", false, "mandatory_payment.paused");
}
export async function activateMandatoryPayment(formData: FormData): Promise<void> {
  await changeStatus(formData, "planned", true, "mandatory_payment.activated");
}
export async function cancelMandatoryPayment(formData: FormData): Promise<void> {
  await changeStatus(formData, "canceled", false, "mandatory_payment.canceled");
}
