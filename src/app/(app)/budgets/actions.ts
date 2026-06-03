"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import {
  getCurrentAccessContext,
  canAccessClub,
  userHasCompanyRole,
  userHasClubRole,
  recordAudit,
} from "@/lib/access";
import {
  BUDGET_CATEGORIES,
  computeUsedKopeks,
  getBudgetRequestForContext,
  isValidMonth,
  REGIONAL_MAX_OVER_PERCENT,
  OWNER_DOUBLE_CONFIRM_PERCENT,
} from "@/lib/budgets";

type BudgetState = { ok: boolean; error?: string };
type RequestState = { ok: boolean; error?: string; withinBudget?: boolean; created?: boolean };

const CATEGORY_KEYS = new Set(BUDGET_CATEGORIES.map((c) => c.key));

async function clubCompanyId(clubId: string): Promise<string | null> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  return club?.companyId ?? null;
}

function parseAmount(formData: FormData): number | null {
  const raw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const n = raw === "" ? 0 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function createOrUpdateBudget(
  _prev: BudgetState | undefined,
  formData: FormData,
): Promise<BudgetState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "budgets")) {
    return { ok: false, error: "Нет доступа" };
  }

  const clubId = String(formData.get("clubId") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const month = String(formData.get("month") ?? "").trim();
  const amount = parseAmount(formData);

  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }
  // Only owner / regional director may manage budgets.
  if (!(await userHasClubRole(ctx.user.id, clubId, ["regional_director"]))) {
    return { ok: false, error: "Управлять бюджетами может владелец или региональный директор" };
  }
  if (!CATEGORY_KEYS.has(category)) return { ok: false, error: "Неверная статья" };
  if (!isValidMonth(month)) return { ok: false, error: "Неверный месяц" };
  if (amount === null) return { ok: false, error: "Сумма должна быть неотрицательной" };

  const companyId = await clubCompanyId(clubId);
  if (!companyId || companyId !== ctx.selectedCompanyId) return { ok: false, error: "Клуб не найден" };

  const existing = await prisma.budget.findUnique({
    where: { clubId_category_month: { clubId, category, month } },
  });

  const budget = await prisma.budget.upsert({
    where: { clubId_category_month: { clubId, category, month } },
    create: {
      companyId,
      clubId,
      category,
      month,
      limitAmountKopeks: rublesToKopeks(amount),
      createdByUserId: ctx.user.id,
    },
    update: { limitAmountKopeks: rublesToKopeks(amount) },
  });

  await recordAudit({
    action: existing ? "budget.updated" : "budget.created",
    entityType: "Budget",
    entityId: budget.id,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { category, month, limitAmountKopeks: budget.limitAmountKopeks },
  });

  revalidatePath("/budgets");
  return { ok: true };
}

export async function requestBudgetApproval(
  _prev: RequestState | undefined,
  formData: FormData,
): Promise<RequestState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "budgets")) {
    return { ok: false, error: "Нет доступа" };
  }

  const clubId = String(formData.get("clubId") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const month = String(formData.get("month") ?? "").trim();
  const sourceType = String(formData.get("sourceType") ?? "manual").trim() || "manual";
  const amount = parseAmount(formData);

  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }
  if (!CATEGORY_KEYS.has(category)) return { ok: false, error: "Неверная статья" };
  if (!isValidMonth(month)) return { ok: false, error: "Неверный месяц" };
  if (amount === null || amount <= 0) return { ok: false, error: "Сумма операции должна быть положительной" };

  const companyId = await clubCompanyId(clubId);
  if (!companyId || companyId !== ctx.selectedCompanyId) return { ok: false, error: "Клуб не найден" };

  const budget = await prisma.budget.findUnique({
    where: { clubId_category_month: { clubId, category, month } },
  });
  const limitKopeks = budget?.limitAmountKopeks ?? 0;
  const usedKopeks = await computeUsedKopeks(clubId, category, month);
  const requestedKopeks = rublesToKopeks(amount);
  const projected = usedKopeks + requestedKopeks;

  if (limitKopeks > 0 && projected <= limitKopeks) {
    return { ok: true, withinBudget: true };
  }

  const overByKopeks = projected - limitKopeks;
  const overByPercent = limitKopeks > 0 ? (overByKopeks / limitKopeks) * 100 : 100;

  const request = await prisma.budgetApprovalRequest.create({
    data: {
      companyId,
      clubId,
      category,
      month,
      requestedAmountKopeks: requestedKopeks,
      currentLimitAmountKopeks: limitKopeks,
      overByAmountKopeks: overByKopeks,
      overByPercent,
      sourceType,
      requestedByUserId: ctx.user.id,
      status: "pending_regional",
    },
  });

  await recordAudit({
    action: "budget.exceeded",
    entityType: "Budget",
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { category, month, overByPercent: Math.round(overByPercent) },
  });
  await recordAudit({
    action: "budget_request.created",
    entityType: "BudgetApprovalRequest",
    entityId: request.id,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { category, month, overByPercent: Math.round(overByPercent) },
  });

  revalidatePath("/budgets");
  return { ok: true, created: true };
}

export async function decideBudgetRequest(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "budgets")) {
    throw new Error("Нет доступа");
  }

  const requestId = String(formData.get("requestId") ?? "").trim();
  const decision = String(formData.get("decision") ?? "").trim();
  const comment = String(formData.get("comment") ?? "").trim() || null;
  const doubleConfirmed =
    String(formData.get("confirm1") ?? "") === "yes" && String(formData.get("confirm2") ?? "") === "yes";

  const req = await getBudgetRequestForContext(ctx, requestId);
  if (!req) throw new Error("Запрос не найден или нет доступа");
  if (req.status === "approved" || req.status === "rejected") {
    throw new Error("Запрос уже обработан");
  }

  const isOwner = await userHasCompanyRole(ctx.user.id, req.companyId, ["owner"]);
  const isRegionalOnly =
    !isOwner && (await userHasClubRole(ctx.user.id, req.clubId, ["regional_director"]));
  if (!isOwner && !isRegionalOnly) throw new Error("Недостаточно прав");

  if (decision === "reject") {
    await prisma.budgetApprovalRequest.update({
      where: { id: req.id },
      data: { status: "rejected", decidedByUserId: ctx.user.id, decidedAt: new Date(), decisionComment: comment },
    });
    await recordAudit({
      action: "budget_request.rejected",
      entityType: "BudgetApprovalRequest",
      entityId: req.id,
      companyId: req.companyId,
      clubId: req.clubId,
      userId: ctx.user.id,
    });
    revalidatePath("/budgets");
    return;
  }

  if (decision !== "approve") throw new Error("Неверное решение");

  // Regional director: only up to +5%, otherwise escalate to owner.
  if (req.status === "pending_regional" && isRegionalOnly) {
    if (req.overByPercent > REGIONAL_MAX_OVER_PERCENT) {
      await prisma.budgetApprovalRequest.update({
        where: { id: req.id },
        data: { status: "pending_owner" },
      });
      await recordAudit({
        action: "budget_request.escalated",
        entityType: "BudgetApprovalRequest",
        entityId: req.id,
        companyId: req.companyId,
        clubId: req.clubId,
        userId: ctx.user.id,
        metadata: { overByPercent: Math.round(req.overByPercent) },
      });
      revalidatePath("/budgets");
      return;
    }
    // within 5% -> regional approves
  } else if (!isOwner) {
    // pending_owner can only be decided by owner
    throw new Error("Согласование на этом этапе доступно только собственнику");
  }

  // Owner approving a large overrun requires double confirmation.
  if (isOwner && req.overByPercent > OWNER_DOUBLE_CONFIRM_PERCENT && !doubleConfirmed) {
    throw new Error("Требуется двойное подтверждение");
  }

  await prisma.budgetApprovalRequest.update({
    where: { id: req.id },
    data: { status: "approved", decidedByUserId: ctx.user.id, decidedAt: new Date(), decisionComment: comment },
  });
  await recordAudit({
    action: "budget_request.approved",
    entityType: "BudgetApprovalRequest",
    entityId: req.id,
    companyId: req.companyId,
    clubId: req.clubId,
    userId: ctx.user.id,
    metadata: { overByPercent: Math.round(req.overByPercent), by: isOwner ? "owner" : "regional" },
  });

  revalidatePath("/budgets");
}
