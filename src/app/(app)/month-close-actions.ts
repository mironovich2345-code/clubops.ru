"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { isValidMonth } from "@/lib/month-close";
import { canCloseMonth } from "@/lib/auth";

export type MonthCloseState = { ok: boolean; error?: string };

function revalidateAll() {
  revalidatePath("/workspace");
  revalidatePath("/dashboard");
  revalidatePath("/expenses");
  revalidatePath("/invoices");
  revalidatePath("/sales");
}

/**
 * Close a company-wide month. Blocks financial changes for that month until it
 * is reopened through the controlled workflow. Chief Accountant only (month.close
 * capability); Owner / GD / ordinary Accountant can no longer close.
 */
export async function closeMonth(_prev: MonthCloseState | undefined, formData: FormData): Promise<MonthCloseState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа" };
  if (!canCloseMonth(ctx.effectiveRoles)) {
    return { ok: false, error: "Закрывать месяц может только главный бухгалтер" };
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

/**
 * DISABLED: direct reopening is no longer allowed. Reopening goes through the
 * controlled workflow (Chief Accountant request -> Owner approval -> Chief
 * Accountant execute; see month-reopen-actions.ts). This stub remains only to
 * deny any direct invocation by a previously-authorized role and audit it.
 */
export async function reopenMonth(_prev: MonthCloseState | undefined, formData: FormData): Promise<MonthCloseState> {
  const ctx = await getCurrentAccessContext();
  const month = String(formData.get("month") ?? "").trim();
  await recordAudit({
    action: "month.reopen_execution_blocked",
    entityType: "MonthClose",
    companyId: ctx?.selectedCompanyId ?? null,
    userId: ctx?.user.id ?? null,
    metadata: { month: isValidMonth(month) ? month : null, reason: "direct_reopen_disabled" },
  });
  return {
    ok: false,
    error: "Прямое переоткрытие отключено. Переоткрытие выполняет главный бухгалтер после согласования собственника.",
  };
}
