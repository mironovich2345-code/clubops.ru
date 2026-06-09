"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { isValidMonth } from "@/lib/month-close";
import type { Role } from "@/lib/auth";

export type MonthCloseState = { ok: boolean; error?: string };

// Close: accountant / general director / owner. Reopen: general director / owner.
function canCloseMonth(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "accountant" || r === "general_director" || r === "owner");
}
function canReopenMonth(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "general_director" || r === "owner");
}

function revalidateAll() {
  revalidatePath("/dashboard");
  revalidatePath("/expenses");
  revalidatePath("/invoices");
  revalidatePath("/sales");
}

/** Close a company-wide month (pilot scope). Blocks financial changes for that
 * month until reopened. Accountant / GD / owner only. */
export async function closeMonth(_prev: MonthCloseState | undefined, formData: FormData): Promise<MonthCloseState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа" };
  if (!canCloseMonth(ctx.effectiveRoles)) {
    return { ok: false, error: "Закрывать месяц могут бухгалтер, ген.директор или собственник" };
  }
  const month = String(formData.get("month") ?? "").trim();
  if (!isValidMonth(month)) return { ok: false, error: "Укажите месяц в формате ГГГГ-ММ" };
  const comment = String(formData.get("comment") ?? "").trim() || null;
  const companyId = ctx.selectedCompanyId;

  // Compound unique contains a nullable clubId — NULLs are distinct in SQL, so
  // upsert can't match; find-then-update/create instead.
  const existing = await prisma.monthClose.findFirst({ where: { companyId, clubId: null, month } });
  if (existing) {
    await prisma.monthClose.update({
      where: { id: existing.id },
      data: { status: "closed", closedByUserId: ctx.user.id, closedAt: new Date(), comment },
    });
  } else {
    await prisma.monthClose.create({
      data: { companyId, clubId: null, month, status: "closed", closedByUserId: ctx.user.id, closedAt: new Date(), comment },
    });
  }

  await recordAudit({
    action: "month.closed",
    entityType: "MonthClose",
    companyId,
    userId: ctx.user.id,
    metadata: { month, comment },
  });

  revalidateAll();
  return { ok: true };
}

/** Reopen a company-wide month. General director / owner only. */
export async function reopenMonth(_prev: MonthCloseState | undefined, formData: FormData): Promise<MonthCloseState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа" };
  if (!canReopenMonth(ctx.effectiveRoles)) {
    return { ok: false, error: "Открывать месяц могут только ген.директор или собственник" };
  }
  const month = String(formData.get("month") ?? "").trim();
  if (!isValidMonth(month)) return { ok: false, error: "Укажите месяц в формате ГГГГ-ММ" };
  const companyId = ctx.selectedCompanyId;

  const existing = await prisma.monthClose.findFirst({ where: { companyId, clubId: null, month } });
  if (existing && existing.status === "closed") {
    await prisma.monthClose.update({ where: { id: existing.id }, data: { status: "open" } });
    await recordAudit({
      action: "month.reopened",
      entityType: "MonthClose",
      entityId: existing.id,
      companyId,
      userId: ctx.user.id,
      metadata: { month },
    });
  }

  revalidateAll();
  return { ok: true };
}
