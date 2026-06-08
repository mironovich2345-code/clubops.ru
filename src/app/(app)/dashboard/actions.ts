"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canManageSalesPlans } from "@/lib/auth";
import { getCurrentAccessContext, getCurrentCompanyAndClub, recordAudit } from "@/lib/access";
import { rublesToKopeks } from "@/lib/money";
import { monthKey, normalizeMonth } from "@/lib/sales-plans";

type SavePlanState = { ok: boolean; error?: string };

/**
 * Creates or updates the monthly sales plan for the CURRENT scope (company-wide
 * if no club is selected, otherwise the selected club). General director only.
 * Scope is derived server-side — no client-provided companyId/clubId is trusted.
 */
export async function saveSalesPlan(
  _prev: SavePlanState | undefined,
  formData: FormData,
): Promise<SavePlanState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx) return { ok: false, error: "Нет доступа" };
  if (!canManageSalesPlans(ctx.effectiveRoles)) {
    return { ok: false, error: "Планы продаж может задавать только Ген.директор" };
  }

  const scope = await getCurrentCompanyAndClub(ctx.user);
  if (!scope.company) return { ok: false, error: "Нет доступной компании" };
  const companyId = scope.company.id;
  const clubId = scope.club?.id ?? null;

  const month = normalizeMonth(String(formData.get("month") ?? "")) ?? monthKey(new Date());

  const amountRaw = String(formData.get("targetAmount") ?? "").trim().replace(",", ".");
  const amount = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "Укажите неотрицательную сумму плана" };
  }
  const targetAmountKopeks = rublesToKopeks(amount);

  const existing = await prisma.salesPlan.findFirst({
    where: { companyId, clubId, month, planType: "total" },
    select: { id: true },
  });

  let planId: string;
  let action: "sales_plan.created" | "sales_plan.updated";
  if (existing) {
    await prisma.salesPlan.update({ where: { id: existing.id }, data: { targetAmountKopeks } });
    planId = existing.id;
    action = "sales_plan.updated";
  } else {
    const created = await prisma.salesPlan.create({
      data: { companyId, clubId, month, planType: "total", targetAmountKopeks, createdByUserId: ctx.user.id },
    });
    planId = created.id;
    action = "sales_plan.created";
  }

  await recordAudit({
    action,
    entityType: "SalesPlan",
    entityId: planId,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { month, targetAmountKopeks },
  });

  revalidatePath("/dashboard");
  return { ok: true };
}
