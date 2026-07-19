"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { canManageSalesPlans } from "@/lib/auth";
import { getCurrentAccessContext, recordAudit, canAccessClub } from "@/lib/access";
import { parseImportAmountToKopeks } from "@/lib/imports/amount";
import { normalizeMonth, PLAN_TYPES } from "@/lib/sales-plans";
import { setActiveScope } from "../scope-actions";

/**
 * Open Analytics scoped to a single club (dashboard club-card click). Reuses the
 * existing scope switch, which independently access-checks the club against the
 * caller's accessible clubs — a forged/unassigned club id is dropped (scope
 * falls back to all clubs), so there is no cross-club leak. Analytics then reads
 * the narrowed scope via getCurrentAccessContext.allowedClubIds.
 */
export async function openClubAnalytics(clubId: string): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx) redirect("/analytics");
  // Cross-Company safe: switch scope to the CLUB's own company (strategic owners
  // may open a club from a company other than the active-scope cookie). Access is
  // independently re-checked; an unassigned club is dropped by setActiveScope.
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  if (club && (await canAccessClub(ctx!.user.id, clubId))) {
    await setActiveScope(club.companyId, clubId);
  }
  redirect("/analytics");
}

type SavePlanState = { ok: boolean; error?: string; saved?: number };

/**
 * Create or update the split sales plan (total / subscriptions / personal
 * training) for a chosen club + month. General director only. Month may be any
 * valid YYYY-MM (current, previous, or future). An empty amount leaves that plan
 * type unchanged; "0" stores an explicit zero. Scope is enforced server-side —
 * the club must be in the caller's allowed clubs and company.
 */
export async function saveSalesPlan(
  _prev: SavePlanState | undefined,
  formData: FormData,
): Promise<SavePlanState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа" };
  if (!canManageSalesPlans(ctx.effectiveRoles)) {
    return { ok: false, error: "Планы продаж может задавать только Ген.директор" };
  }
  const companyId = ctx.selectedCompanyId;

  const month = normalizeMonth(String(formData.get("month") ?? ""));
  if (!month) return { ok: false, error: "Укажите месяц в формате ГГГГ-ММ" };

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId) return { ok: false, error: "Выберите клуб" };
  if (!ctx.allowedClubIds.includes(clubId)) return { ok: false, error: "Нет доступа к выбранному клубу" };
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  if (!club || club.companyId !== companyId) return { ok: false, error: "Клуб не найден" };

  let saved = 0;
  for (const t of PLAN_TYPES) {
    // Accept grouped input ("2 500 000", "2.500.000"); empty = do not change.
    const parsed = parseImportAmountToKopeks(String(formData.get(`amount_${t.key}`) ?? ""));
    if ("empty" in parsed) continue;
    if ("error" in parsed) {
      return { ok: false, error: `Неверная сумма для «${t.label}» (нужно число ≥ 0)` };
    }
    const targetAmountKopeks = parsed.kopeks;

    const existing = await prisma.salesPlan.findFirst({
      where: { companyId, clubId, month, planType: t.key },
      select: { id: true },
    });
    if (existing) {
      await prisma.salesPlan.update({ where: { id: existing.id }, data: { targetAmountKopeks } });
      await recordAudit({
        action: "sales_plan.updated",
        entityType: "SalesPlan",
        entityId: existing.id,
        companyId,
        clubId,
        userId: ctx.user.id,
        metadata: { month, planType: t.key, targetAmountKopeks },
      });
    } else {
      const created = await prisma.salesPlan.create({
        data: { companyId, clubId, month, planType: t.key, targetAmountKopeks, createdByUserId: ctx.user.id },
      });
      await recordAudit({
        action: "sales_plan.created",
        entityType: "SalesPlan",
        entityId: created.id,
        companyId,
        clubId,
        userId: ctx.user.id,
        metadata: { month, planType: t.key, targetAmountKopeks },
      });
    }
    saved++;
  }

  if (saved === 0) return { ok: false, error: "Заполните хотя бы один план" };

  revalidatePath("/dashboard");
  revalidatePath("/analytics");
  return { ok: true, saved };
}
