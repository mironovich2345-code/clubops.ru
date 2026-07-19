"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser, canCreateOperational } from "@/lib/auth";
import {
  getCurrentAccessContext, recordAudit,
  userHasCompanyRole, userHasClubRole, hasActiveRegionalApproverForClub,
} from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { notifyRegionalReview, notifyAuthor } from "@/lib/notifications/events";
import { getExpenseForContext, isCashForbiddenCategory } from "@/lib/expenses";
import { buildExpenseTitle } from "@/lib/expense-title";
import { isActiveExpenseCategoryKey } from "@/lib/expense-categories";
import { activeDocumentCount } from "@/lib/expense-attachments";
import {
  EXP, ExpenseActor, parseRublesToKopeks, validateExpenseBusinessDate, resolveActiveIpForClub,
  routeExpenseBudget, canEditExpense, canSubmitExpense, canApproveRegionalExpense,
  canApproveOwnerExpense, canVerifyExpense, canReturnExpenseForCorrection, canCancelExpense,
  canChangeExpenseDate,
} from "@/lib/expense-simplified";
import { ensureClubCashWallet, ensureRegionalCashWallet, recordExpenseMovement } from "@/lib/cash-wallets";

const MAX_COMMENT = 2000;

type CreateState = { ok: boolean; error?: string; expenseId?: string };
type State = { ok: boolean; error?: string };

const E = {
  ACCESS: "Нет доступа.",
  NOT_EDITABLE: "Расход больше нельзя редактировать.",
  STALE: "Данные изменились в другой вкладке. Обновите страницу.",
  MONTH_CLOSED: "Месяц закрыт. Добавление или изменение расходов недоступно.",
  DATE_FUTURE: "Дата не может быть в будущем.",
  CATEGORY_DISABLED: "Статья расходов отключена или не найдена.",
  CATEGORY_NOT_CASH: "Эта статья не оплачивается наличными.",
  NO_CATEGORY: "Нет активных статей расходов. Обратитесь к главному бухгалтеру.",
  EMPLOYEE: "Выбранный сотрудник недоступен.",
  AMOUNT: "Укажите корректную сумму больше нуля.",
  COMMENT: "Комментарий обязателен.",
  SHOPPING: "Список покупок/оплат обязателен.",
  NO_DOC: "Прикрепите хотя бы один документ.",
  NO_REGIONAL: "Для клуба не назначен региональный директор. Обратитесь к администратору.",
  BAD_STATUS: "Неверный статус для этого действия.",
  VERIFIED: "Расход уже проверен.",
  CANCELLED: "Расход уже отменён.",
  CORRECTION_REASON: "Причина исправления обязательна.",
  CANCEL_REASON: "Причина отмены обязательна.",
  DATE_REASON: "Причина изменения даты обязательна.",
  DATE_WINDOW: "Изменение даты недоступно (прошло более 7 дней).",
} as const;

async function buildActor(userId: string, roles: readonly import("@/lib/auth").Role[], allowedClubIds: readonly string[], companyId: string, clubId: string): Promise<ExpenseActor> {
  const [companyOwner, regionalForClub] = await Promise.all([
    userHasCompanyRole(userId, companyId, ["owner"]),
    roles.includes("regional_director") ? userHasClubRole(userId, clubId, ["regional_director"]) : Promise.resolve(false),
  ]);
  return {
    userId, roles, allowedClubIds,
    companyOwner,
    regionalForClub,
    accountant: roles.includes("accountant") || roles.includes("chief_accountant"),
    manager: canCreateOperational(roles),
  };
}

async function loadForAction(expenseId: string) {
  const ctx = await getCurrentAccessContext();
  if (!ctx) return { error: E.ACCESS as string };
  const expense = await getExpenseForContext(ctx, expenseId);
  if (!expense) return { error: E.ACCESS as string };
  const actor = await buildActor(ctx.user.id, ctx.effectiveRoles, ctx.allowedClubIds, expense.companyId, expense.clubId);
  return { ctx, expense, actor };
}

// Validate the shared simplified fields from FormData. Returns parsed values or
// an error. The payer is NOT read here — it is the authenticated user (set by
// the create action). No "shopping list" field anymore (legacy column kept, not
// required for new cash expenses).
async function parseFields(formData: FormData) {
  const categoryKey = String(formData.get("category") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "");
  const dateRaw = String(formData.get("expenseDate") ?? "").trim();
  const comment = String(formData.get("comment") ?? "").trim();

  if (!categoryKey || !(await isActiveExpenseCategoryKey(categoryKey))) return { error: E.CATEGORY_DISABLED };
  // Stable-key gate: taxes/rent/builders are never paid in cash (v2 form only).
  if (isCashForbiddenCategory(categoryKey)) return { error: E.CATEGORY_NOT_CASH };
  const amt = parseRublesToKopeks(amountRaw);
  if (!amt.ok) return { error: E.AMOUNT };
  const m = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { error: E.DATE_FUTURE };
  const expenseDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const dateCheck = validateExpenseBusinessDate(expenseDate);
  if (!dateCheck.ok) return { error: dateCheck.error };
  if (!comment) return { error: E.COMMENT };
  if (comment.length > MAX_COMMENT) return { error: "Комментарий слишком длинный." };

  return { categoryKey, amountKopeks: amt.kopeks, expenseDate, comment };
}

/** Create a simplified (entryVersion=2) draft. Company/Club/ИП/cash are server-resolved. */
export async function createSimplifiedExpenseDraft(_prev: CreateState | undefined, formData: FormData): Promise<CreateState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canCreateOperational(ctx.effectiveRoles)) return { ok: false, error: E.ACCESS };
  const companyId = ctx.selectedCompanyId;
  const clubId = ctx.selectedClubId ?? (ctx.allowedClubIds.length === 1 ? ctx.allowedClubIds[0] : null);
  if (!companyId || !clubId || !ctx.allowedClubIds.includes(clubId)) return { ok: false, error: "Выберите клуб." };

  const fields = await parseFields(formData);
  if ("error" in fields) return { ok: false, error: fields.error };

  const closed = await monthClosedError(companyId, clubId, fields.expenseDate);
  if (closed) return { ok: false, error: E.MONTH_CLOSED };
  const ip = await resolveActiveIpForClub(clubId);
  if (!ip.ok) return { ok: false, error: ip.error };

  const categoryName = String(formData.get("categoryName") ?? fields.categoryKey);
  // Title is derived from the comment now (the shopping-list field is gone).
  const generatedTitle = buildExpenseTitle(categoryName, fields.comment);
  const now = new Date();
  // Payer is ALWAYS the authenticated user — the client cannot choose or spoof
  // it (no paidByUserId is read from the form).
  const paidByUserId = ctx.user.id;
  // Wallet is resolved server-side (manager never chooses it): a regional
  // director spends from their own regional_cash wallet for this Club; everyone
  // else (managers) from the Club's club_cash wallet.
  const cashWalletId = ctx.effectiveRoles.includes("regional_director")
    ? await ensureRegionalCashWallet(companyId, clubId, ip.legalEntityId, ctx.user.id)
    : await ensureClubCashWallet(companyId, clubId, ip.legalEntityId);
  const expense = await prisma.expense.create({
    data: {
      companyId, clubId, createdByUserId: ctx.user.id, entryVersion: 2, type: "receipt",
      status: EXP.DRAFT, category: fields.categoryKey, amountKopeks: fields.amountKopeks,
      expenseDate: fields.expenseDate, comment: fields.comment,
      generatedTitle, paidByUserId, legalEntityId: ip.legalEntityId,
      paymentMethod: "cash", firstSavedAt: now, cashWalletId,
    },
  });
  await recordAudit({ action: "expense.draft_created", entityType: "Expense", entityId: expense.id, companyId, clubId, userId: ctx.user.id, metadata: { amountKopeks: fields.amountKopeks, category: fields.categoryKey, paidByUserId } });
  revalidatePath("/expenses");
  return { ok: true, expenseId: expense.id };
}

/** Edit a draft/needs_correction expense (optimistic lock via expectedUpdatedAt). */
export async function updateSimplifiedExpense(_prev: State | undefined, formData: FormData): Promise<State> {
  const expenseId = String(formData.get("expenseId") ?? "").trim();
  const expected = String(formData.get("expectedUpdatedAt") ?? "").trim();
  const loaded = await loadForAction(expenseId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const { ctx, expense, actor } = loaded;
  if (!canEditExpense(expense, actor)) return { ok: false, error: E.NOT_EDITABLE };
  const closed = await monthClosedError(expense.companyId, expense.clubId, expense.expenseDate);
  if (closed) return { ok: false, error: E.MONTH_CLOSED };

  const fields = await parseFields(formData);
  if ("error" in fields) return { ok: false, error: fields.error };
  const closedNew = await monthClosedError(expense.companyId, expense.clubId, fields.expenseDate);
  if (closedNew) return { ok: false, error: E.MONTH_CLOSED };

  const categoryName = String(formData.get("categoryName") ?? fields.categoryKey);
  const generatedTitle = buildExpenseTitle(categoryName, fields.comment);
  // Optimistic concurrency: only update if the row hasn't changed since load.
  // paidByUserId and the legacy shoppingListText are intentionally NOT touched —
  // the payer is never changed via the client and old drafts keep their data.
  const res = await prisma.expense.updateMany({
    where: { id: expenseId, status: { in: ["draft", "needs_correction"] }, ...(expected ? { updatedAt: new Date(expected) } : {}) },
    data: { category: fields.categoryKey, amountKopeks: fields.amountKopeks, expenseDate: fields.expenseDate, comment: fields.comment, generatedTitle },
  });
  if (res.count === 0) return { ok: false, error: E.STALE };
  await recordAudit({ action: "expense.draft_updated", entityType: "Expense", entityId: expenseId, companyId: expense.companyId, clubId: expense.clubId, userId: ctx.user.id, metadata: { amountKopeks: fields.amountKopeks, category: fields.categoryKey } });
  revalidatePath(`/expenses/${expenseId}`);
  return { ok: true };
}

/** Submit / resubmit: recheck everything, route by budget, move to the next status. */
export async function submitExpense(_prev: State | undefined, formData: FormData): Promise<State> {
  const expenseId = String(formData.get("expenseId") ?? "").trim();
  const loaded = await loadForAction(expenseId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const { ctx, expense, actor } = loaded;
  if (!canSubmitExpense(expense, actor)) return { ok: false, error: E.NOT_EDITABLE };
  const closed = await monthClosedError(expense.companyId, expense.clubId, expense.expenseDate);
  if (closed) return { ok: false, error: E.MONTH_CLOSED };
  if (!(await isActiveExpenseCategoryKey(expense.category))) return { ok: false, error: E.CATEGORY_DISABLED };
  // v2 cash defense: never submit a cash expense in a non-cash category.
  if (expense.entryVersion === 2 && isCashForbiddenCategory(expense.category)) return { ok: false, error: E.CATEGORY_NOT_CASH };
  if ((await activeDocumentCount(expenseId)) < 1) return { ok: false, error: E.NO_DOC };
  const ip = await resolveActiveIpForClub(expense.clubId);
  if (!ip.ok) return { ok: false, error: ip.error };

  const wasResubmit = expense.status === EXP.NEEDS_CORRECTION;
  // Budget route is still computed and stored (analytics: overrun / level), but it
  // no longer decides the next status. Pilot routing is by the CREATOR's role,
  // read from the DB (never trusting client/FormData role):
  //  - a manager's expense ALWAYS goes to the regional director first (any budget);
  //    it may NEVER be auto-routed to accounting / owner / any other role instead;
  //  - a regional director's OWN expense skips regional review (they cannot
  //    self-approve) and goes straight to accounting.
  const route = await routeExpenseBudget({ clubId: expense.clubId, category: expense.category, expenseDate: expense.expenseDate, amountKopeks: expense.amountKopeks });
  const creatorIsRegional = await userHasClubRole(expense.createdByUserId, expense.clubId, ["regional_director"]);
  let nextStatus: string;
  let reviewTarget: "regional" | "accountant";
  if (creatorIsRegional) {
    nextStatus = EXP.PENDING_ACCOUNTANT; reviewTarget = "accountant";
  } else if (await hasActiveRegionalApproverForClub(expense.companyId, expense.clubId)) {
    nextStatus = EXP.PENDING_REGIONAL; reviewTarget = "regional";
  } else {
    // A manager's expense with no active regional director for the club is BLOCKED:
    // the status and attached documents stay exactly as they are (no update runs),
    // and the user is told to have a regional director assigned. It is never sent
    // to accounting/owner as a fallback.
    return { ok: false, error: E.NO_REGIONAL };
  }
  const now = new Date();
  const res = await prisma.expense.updateMany({
    where: { id: expenseId, status: { in: ["draft", "needs_correction"] } },
    data: {
      status: nextStatus, submittedAt: now, legalEntityId: ip.legalEntityId, paymentMethod: "cash",
      budgetOverrunKopeks: route.overrunKopeks, budgetOverrunBasisPoints: route.overrunBasisPoints, budgetApprovalLevel: route.level,
      // Clear the active correction request on resubmission (history stays in audit).
      correctionReason: null, correctionRequestedAt: null, correctionRequestedByUserId: null,
    },
  });
  if (res.count === 0) return { ok: false, error: E.BAD_STATUS }; // idempotent: already submitted
  await recordAudit({ action: wasResubmit ? "expense.resubmitted" : "expense.submitted", entityType: "Expense", entityId: expenseId, companyId: expense.companyId, clubId: expense.clubId, userId: ctx.user.id, metadata: { amountKopeks: expense.amountKopeks, overrunBasisPoints: route.overrunBasisPoints, level: route.level, reviewTarget } });
  const routedAction = reviewTarget === "regional" ? "expense.routed_to_regional" : "expense.routed_to_accounting";
  await recordAudit({ action: routedAction, entityType: "Expense", entityId: expenseId, companyId: expense.companyId, clubId: expense.clubId, userId: ctx.user.id, metadata: { reviewTarget, level: route.level, overrunBasisPoints: route.overrunBasisPoints } });
  // Notify the regional director(s) of a manager's submission (best-effort; a
  // Telegram failure never affects the submission).
  if (reviewTarget === "regional") {
    await notifyRegionalReview({ resourceType: "expense", resourceId: expenseId, companyId: expense.companyId, clubId: expense.clubId, amountKopeks: expense.amountKopeks, actorUserId: ctx.user.id, isResubmit: wasResubmit });
  }
  revalidatePath(`/expenses/${expenseId}`);
  return { ok: true };
}

type ExpenseLite = Awaited<ReturnType<typeof getExpenseForContext>>;

async function transition(formData: FormData, opts: {
  guard: (e: NonNullable<ExpenseLite>, a: ExpenseActor) => boolean;
  fromStatus: string[]; toStatus: string; audit: string;
  reasonError?: string; // when set, a non-empty `reason` field is required
  extra?: (userId: string, reason: string) => Record<string, unknown>;
  // Best-effort side effect (e.g. notifications) after a successful transition.
  onSuccess?: (expense: NonNullable<ExpenseLite>, actorId: string) => Promise<void>;
}): Promise<State> {
  const expenseId = String(formData.get("expenseId") ?? "").trim();
  const loaded = await loadForAction(expenseId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const { ctx, expense, actor } = loaded;
  if (!opts.guard(expense, actor)) return { ok: false, error: E.BAD_STATUS };
  const closed = await monthClosedError(expense.companyId, expense.clubId, expense.expenseDate);
  if (closed) return { ok: false, error: E.MONTH_CLOSED };

  let reason = "";
  if (opts.reasonError) {
    reason = String(formData.get("reason") ?? "").trim();
    if (!reason) return { ok: false, error: opts.reasonError };
  }
  const res = await prisma.expense.updateMany({
    where: { id: expenseId, status: { in: opts.fromStatus } },
    data: { status: opts.toStatus, ...(opts.extra ? opts.extra(ctx.user.id, reason) : {}) },
  });
  if (res.count === 0) return { ok: false, error: E.BAD_STATUS }; // idempotent (already transitioned)
  await recordAudit({ action: opts.audit, entityType: "Expense", entityId: expenseId, companyId: expense.companyId, clubId: expense.clubId, userId: ctx.user.id, metadata: { from: expense.status, to: opts.toStatus, ...(reason ? { reasonLen: reason.length } : {}) } });
  if (opts.onSuccess) await opts.onSuccess(expense, ctx.user.id);
  revalidatePath(`/expenses/${expenseId}`);
  return { ok: true };
}

export async function approveRegionalBudget(_p: State | undefined, formData: FormData): Promise<State> {
  return transition(formData, {
    guard: canApproveRegionalExpense, fromStatus: [EXP.PENDING_REGIONAL], toStatus: EXP.PENDING_ACCOUNTANT, audit: "expense.regional_budget_approved",
    onSuccess: (e, actorId) => notifyAuthor({ resourceType: "expense", resourceId: e.id, companyId: e.companyId, clubId: e.clubId, amountKopeks: e.amountKopeks, authorUserId: e.createdByUserId, actorUserId: actorId, event: "approved" }),
  });
}
export async function approveOwnerBudget(_p: State | undefined, formData: FormData): Promise<State> {
  return transition(formData, { guard: canApproveOwnerExpense, fromStatus: [EXP.PENDING_OWNER], toStatus: EXP.PENDING_ACCOUNTANT, audit: "expense.owner_budget_approved" });
}
export async function verifyExpense(_p: State | undefined, formData: FormData): Promise<State> {
  const expenseId = String(formData.get("expenseId") ?? "").trim();
  if ((await activeDocumentCount(expenseId)) < 1) return { ok: false, error: E.NO_DOC };
  const res = await transition(formData, {
    guard: canVerifyExpense, fromStatus: [EXP.PENDING_ACCOUNTANT], toStatus: EXP.VERIFIED, audit: "expense.accounting_verified",
    extra: (userId) => ({ verifiedAt: new Date(), verifiedByUserId: userId }),
  });
  // Realize the cash effect exactly once: only when THIS call performed the
  // draft→verified transition (res.ok). recordExpenseMovement is idempotent per
  // Expense, so any duplicate can never reduce cash twice.
  if (res.ok) {
    const exp = await prisma.expense.findUnique({ where: { id: expenseId }, select: { id: true, companyId: true, clubId: true, legalEntityId: true, amountKopeks: true, expenseDate: true, cashWalletId: true } });
    if (exp) await recordExpenseMovement(exp);
  }
  return res;
}
export async function returnForCorrection(_p: State | undefined, formData: FormData): Promise<State> {
  return transition(formData, {
    guard: canReturnExpenseForCorrection, fromStatus: [EXP.PENDING_REGIONAL, EXP.PENDING_OWNER, EXP.PENDING_ACCOUNTANT],
    toStatus: EXP.NEEDS_CORRECTION, audit: "expense.returned_for_correction", reasonError: E.CORRECTION_REASON,
    extra: (userId, reason) => ({ correctionRequestedAt: new Date(), correctionRequestedByUserId: userId, correctionReason: reason.slice(0, 300) }),
    onSuccess: (e, actorId) => notifyAuthor({ resourceType: "expense", resourceId: e.id, companyId: e.companyId, clubId: e.clubId, amountKopeks: e.amountKopeks, authorUserId: e.createdByUserId, actorUserId: actorId, event: "returned" }),
  });
}
export async function cancelSimplifiedExpense(_p: State | undefined, formData: FormData): Promise<State> {
  return transition(formData, {
    guard: canCancelExpense, fromStatus: ["draft", "submitted", "pending_regional_budget_approval", "pending_owner_budget_approval", "pending_accountant_verification", "needs_correction"],
    toStatus: EXP.CANCELLED, audit: "expense.cancelled", reasonError: E.CANCEL_REASON,
    extra: (userId, reason) => ({ cancelledAt: new Date(), cancelledByUserId: userId, cancellationReason: reason.slice(0, 300) }),
  });
}

/** Regional-director date correction (7-day window from first save). Reason required. */
export async function changeExpenseDate(_p: State | undefined, formData: FormData): Promise<State> {
  const expenseId = String(formData.get("expenseId") ?? "").trim();
  const dateRaw = String(formData.get("expenseDate") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const loaded = await loadForAction(expenseId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const { ctx, expense, actor } = loaded;
  if (!canChangeExpenseDate(expense, actor)) return { ok: false, error: E.DATE_WINDOW };
  if (!reason) return { ok: false, error: E.DATE_REASON };
  const m = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { ok: false, error: E.DATE_FUTURE };
  const newDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const dc = validateExpenseBusinessDate(newDate);
  if (!dc.ok) return { ok: false, error: dc.error };
  const closedOld = await monthClosedError(expense.companyId, expense.clubId, expense.expenseDate);
  const closedNew = await monthClosedError(expense.companyId, expense.clubId, newDate);
  if (closedOld || closedNew) return { ok: false, error: E.MONTH_CLOSED };

  const res = await prisma.expense.updateMany({ where: { id: expenseId, status: { notIn: ["verified", "cancelled"] } }, data: { expenseDate: newDate } });
  if (res.count === 0) return { ok: false, error: E.BAD_STATUS };
  await recordAudit({ action: "expense.date_changed", entityType: "Expense", entityId: expenseId, companyId: expense.companyId, clubId: expense.clubId, userId: ctx.user.id, metadata: { oldDate: expense.expenseDate.toISOString().slice(0, 10), newDate: newDate.toISOString().slice(0, 10), reasonLen: reason.length } });
  revalidatePath(`/expenses/${expenseId}`);
  return { ok: true };
}
