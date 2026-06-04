"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, canAccessClub, recordAudit } from "@/lib/access";
import {
  applySaleAction,
  getSaleForContext,
  SALE_ACTION_AUDIT,
  type SaleAction,
} from "@/lib/sales";

export type CreateSaleState = {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<
    "clubId" | "source" | "amount" | "saleDate",
    string
  >>;
};

function parseDateInput(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function createSale(
  _prev: CreateSaleState | undefined,
  formData: FormData,
): Promise<CreateSaleState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "sales")) {
    return { ok: false, error: "Нет доступа" };
  }
  const user = ctx.user;

  const clubId = String(formData.get("clubId") ?? "").trim();
  const source = String(formData.get("source") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const saleDateRaw = String(formData.get("saleDate") ?? "").trim();
  const commentRaw = String(formData.get("comment") ?? "").trim();

  const fieldErrors: CreateSaleState["fieldErrors"] = {};

  if (!clubId) fieldErrors.clubId = "Выберите клуб";
  if (!source) fieldErrors.source = "Выберите источник";

  const amount = Number(amountRaw);
  if (!amountRaw || Number.isNaN(amount) || amount <= 0) {
    fieldErrors.amount = "Сумма должна быть положительной";
  }

  if (!saleDateRaw) {
    fieldErrors.saleDate = "Укажите дату продажи";
  }
  const saleDate = parseDateInput(saleDateRaw);
  if (saleDateRaw && !saleDate) fieldErrors.saleDate = "Неверная дата";

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: "Проверьте поля формы", fieldErrors };
  }

  if (!(await canAccessClub(user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { companyId: true },
  });
  if (!club) return { ok: false, error: "Клуб не найден" };

  const sale = await prisma.sale.create({
    data: {
      companyId: club.companyId,
      clubId,
      createdByUserId: user.id,
      submittedByUserId: user.id,
      status: "pending_accountant",
      source,
      amountKopeks: rublesToKopeks(amount),
      saleDate: saleDate!,
      comment: commentRaw || null,
    },
  });

  await recordAudit({
    action: "sale.created",
    entityType: "Sale",
    entityId: sale.id,
    companyId: club.companyId,
    clubId,
    userId: user.id,
    metadata: { source, amountKopeks: sale.amountKopeks, status: "pending_accountant" },
  });

  revalidatePath("/sales");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Accountant verification transition: confirm / reject / cancel a sale. All
 * authorization runs through getCurrentAccessContext + getSaleForContext (scoped
 * to the user's company/clubs) and the pure applySaleAction decision table — no
 * client-provided companyId/clubId is trusted.
 */
export async function transitionSale(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "sales")) {
    throw new Error("Нет доступа");
  }

  const saleId = String(formData.get("saleId") ?? "").trim();
  const action = String(formData.get("action") ?? "").trim() as SaleAction;
  if (!(action in SALE_ACTION_AUDIT)) throw new Error("Неверное действие");

  const existing = await getSaleForContext(ctx, saleId);
  if (!existing) throw new Error("Продажа не найдена или нет доступа");

  const isCreator = existing.createdByUserId === ctx.user.id;
  const result = applySaleAction(action, existing.status, ctx.effectiveRoles, isCreator);
  if (!result.ok) throw new Error(result.error);

  const reason = String(formData.get("rejectionReason") ?? "").trim() || null;
  const now = new Date();

  await prisma.sale.update({
    where: { id: saleId },
    data: {
      status: result.to,
      ...(result.to === "confirmed" ? { verifiedByUserId: ctx.user.id, verifiedAt: now } : {}),
      ...(result.to === "rejected"
        ? { rejectedByUserId: ctx.user.id, rejectedAt: now, rejectionReason: reason }
        : {}),
    },
  });

  await recordAudit({
    action: SALE_ACTION_AUDIT[action],
    entityType: "Sale",
    entityId: saleId,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
    metadata: { from: existing.status, to: result.to, action, ...(reason ? { reason } : {}) },
  });

  revalidatePath("/sales");
  revalidatePath("/dashboard");
}
