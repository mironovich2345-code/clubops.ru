"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import {
  getCurrentAccessContext,
  canAccessClub,
  userHasClubRole,
  getManageableClubIds,
  recordAudit,
} from "@/lib/access";
import {
  BUDGET_CATEGORIES,
  getBudgetRequestForContext,
  isBudgetRequestPending,
  isValidMonth,
  SOURCE_STATUS_REJECTED,
} from "@/lib/budgets";

type BudgetState = { ok: boolean; error?: string };

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

// ---------------------------------------------------------------------------
// Budget-overrun approval decisions.
//
// Approval rights (effective roles, scoped):
//   owner / general_director -> any club in the company
//   regional_director        -> only assigned clubs
//   accountant / manager / marketer -> cannot decide
// getManageableClubIds encodes exactly this (owner/GD -> all clubs; RD ->
// assigned). The requester can never decide their own request.
// ---------------------------------------------------------------------------

async function loadDecidableRequest(requestId: string) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "budgets")) {
    throw new Error("Нет доступа");
  }
  const req = await getBudgetRequestForContext(ctx, requestId);
  if (!req) throw new Error("Запрос не найден или нет доступа");
  if (!isBudgetRequestPending(req.status)) throw new Error("Запрос уже обработан");

  const manageableClubIds = await getManageableClubIds(ctx.user.id, req.companyId);
  if (!manageableClubIds.includes(req.clubId)) throw new Error("Недостаточно прав для согласования");
  if (req.requestedByUserId === ctx.user.id) {
    throw new Error("Нельзя согласовать собственный запрос");
  }
  return { ctx, req };
}

/** Apply the decision outcome to the source record (expense for now). */
async function applyDecisionToSource(
  sourceType: string,
  sourceId: string | null,
  outcome: "approved" | "rejected",
): Promise<void> {
  if (!sourceId) return;
  if (sourceType === "expense") {
    await prisma.expense.update({
      where: { id: sourceId },
      data: { status: outcome === "approved" ? "confirmed" : SOURCE_STATUS_REJECTED },
    });
  }
}

export async function approveBudgetRequest(formData: FormData): Promise<void> {
  const requestId = String(formData.get("requestId") ?? "").trim();
  const { ctx, req } = await loadDecidableRequest(requestId);

  await prisma.budgetApprovalRequest.update({
    where: { id: req.id },
    data: {
      status: "approved",
      approvedByUserId: ctx.user.id,
      approvedAt: new Date(),
      // Keep legacy decision columns consistent.
      decidedByUserId: ctx.user.id,
      decidedAt: new Date(),
    },
  });
  await applyDecisionToSource(req.sourceType, req.sourceId, "approved");

  await recordAudit({
    action: "budget_approval.approved",
    entityType: "BudgetApprovalRequest",
    entityId: req.id,
    companyId: req.companyId,
    clubId: req.clubId,
    userId: ctx.user.id,
    metadata: { sourceType: req.sourceType, sourceId: req.sourceId, overrunKopeks: req.overrunKopeks },
  });

  revalidatePath("/budgets");
  revalidatePath("/dashboard");
  revalidatePath("/expenses");
}

export async function rejectBudgetRequest(formData: FormData): Promise<void> {
  const requestId = String(formData.get("requestId") ?? "").trim();
  const reason = String(formData.get("comment") ?? "").trim() || null;
  const { ctx, req } = await loadDecidableRequest(requestId);

  await prisma.budgetApprovalRequest.update({
    where: { id: req.id },
    data: {
      status: "rejected",
      rejectedByUserId: ctx.user.id,
      rejectedAt: new Date(),
      decidedByUserId: ctx.user.id,
      decidedAt: new Date(),
      decisionComment: reason,
    },
  });
  await applyDecisionToSource(req.sourceType, req.sourceId, "rejected");

  await recordAudit({
    action: "budget_approval.rejected",
    entityType: "BudgetApprovalRequest",
    entityId: req.id,
    companyId: req.companyId,
    clubId: req.clubId,
    userId: ctx.user.id,
    metadata: { sourceType: req.sourceType, sourceId: req.sourceId, overrunKopeks: req.overrunKopeks },
  });

  revalidatePath("/budgets");
  revalidatePath("/dashboard");
  revalidatePath("/expenses");
}
