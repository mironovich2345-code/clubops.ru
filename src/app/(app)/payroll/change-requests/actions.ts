"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, recordAudit } from "@/lib/access";
import { canProposePayrollChange, canReviewPayrollChange } from "@/lib/payroll/access";
import { getPeriodForScope } from "@/lib/payroll/periods";
import { isPayrollPeriodClosed } from "@/lib/payroll/period";
import { recomputeCalculationTotals } from "@/lib/payroll/aggregate";
import { computeScheme, type PeriodInput } from "@/lib/payroll/compute";
import { recomputeGymTrainerCalculation } from "@/app/(app)/payroll/periods/trainer-actions";
import { materializeApprovedSchemeChange } from "@/lib/payroll/scheme-service";
import { notifyPayrollChangeReview, notifyPayrollChangeDecision } from "@/lib/notifications/events";
import {
  allowedFieldsForScheme,
  assertFieldAllowed,
  fieldLabel,
  parseProposedScalar,
  previewChangeImpact,
  effectiveSchemeParams,
  applyOverridesToParams,
  parseApprovedOverrides,
  appendHistory,
  canTransition,
  type ChangeFieldType,
  type ChangeRequestType,
  type OverrideEntry,
} from "@/lib/payroll/change-request";

export type ChangeRequestState = { ok: boolean; error?: string; requestId?: string; notice?: string };
const fail = (error: string): ChangeRequestState => ({ ok: false, error });

// ---- scope helpers ----------------------------------------------------------

async function ctxScope() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false as const, error: "Нет доступа" };
  const companyId = ctx.selectedCompanyId;
  const clubIds = (await getUserClubs(ctx.user.id, companyId)).map((c) => c.id);
  return { ok: true as const, ctx, companyId, clubIds };
}

/** Load a calculation + its period, enforcing tenant + club scope (IDOR guard, §19). */
async function resolveCalcScope(calculationId: string) {
  const base = await ctxScope();
  if (!base.ok) return base;
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: calculationId } });
  if (!calc || calc.companyId !== base.companyId) return { ok: false as const, error: "Расчёт не найден" };
  const period = await getPeriodForScope(base.companyId, base.clubIds, calc.payrollPeriodId);
  if (!period) return { ok: false as const, error: "Период вне зоны доступа" };
  return { ...base, calc, period };
}

/** Load a change request, enforcing tenant + club scope. */
async function resolveRequestScope(requestId: string) {
  const base = await ctxScope();
  if (!base.ok) return base;
  const req = await prisma.payrollChangeRequest.findUnique({ where: { id: requestId } });
  if (!req || req.companyId !== base.companyId || !base.clubIds.includes(req.clubId))
    return { ok: false as const, error: "Заявка не найдена" };
  return { ...base, req };
}

// ---- compute context from a calc -------------------------------------------

type CalcCtx = { schemeType: string; baseParams: Record<string, unknown>; input: PeriodInput; overrides: OverrideEntry[] };

function calcComputeContext(calc: { schemeSnapshotJson: string | null; detailsJson: string | null; approvedOverridesJson: string | null }): CalcCtx | null {
  if (!calc.schemeSnapshotJson) return null;
  let snap: { schemeType?: string; params?: Record<string, unknown> };
  try {
    snap = JSON.parse(calc.schemeSnapshotJson);
  } catch {
    return null;
  }
  if (!snap.schemeType) return null;
  let input: PeriodInput = {};
  if (calc.detailsJson) {
    try {
      const d = JSON.parse(calc.detailsJson) as { inputJson?: string };
      if (d.inputJson) input = JSON.parse(d.inputJson) as PeriodInput;
    } catch {
      /* no stored input yet */
    }
  }
  return {
    schemeType: snap.schemeType,
    baseParams: snap.params ?? {},
    input,
    overrides: parseApprovedOverrides(calc.approvedOverridesJson).overrides,
  };
}

/** Current effective value of a scheme field (base + already-approved overrides). */
function currentFieldValue(cc: CalcCtx, targetField: string): unknown {
  const eff = applyOverridesToParams(cc.schemeType, cc.baseParams, cc.overrides);
  if (eff.ok) {
    const params = (eff.scheme as { params: Record<string, unknown> }).params;
    return params[targetField];
  }
  return cc.baseParams[targetField];
}

// ---- propose (regional, §2 §8 §21) -----------------------------------------

/**
 * A regional director PROPOSES a change to a locked payroll parameter. The request is
 * created SUBMITTED — it does NOT affect the calculation total until a GD/owner approves
 * it. Impact is previewed through the SAME calc path as apply (spec §23); when there is
 * no base to compute against it is stored as "cannot compute", never a fake 0 (§8).
 */
export async function proposePeriodChange(_prev: ChangeRequestState | undefined, formData: FormData): Promise<ChangeRequestState> {
  const calculationId = String(formData.get("calculationId") ?? "").trim();
  const scope = await resolveCalcScope(calculationId);
  if (!scope.ok) return fail(scope.error);
  if (!canProposePayrollChange(scope.ctx.effectiveRoles)) return fail("Только региональный директор может предложить изменение.");
  if (isPayrollPeriodClosed(scope.period.status)) return fail("Период закрыт — предложить изменение нельзя.");

  const cc = calcComputeContext(scope.calc);
  if (!cc) return fail("Схема оплаты не зафиксирована для этого расчёта.");

  const fieldType = String(formData.get("fieldType") ?? "").trim() as ChangeFieldType;
  const reason = String(formData.get("reason") ?? "").trim();
  const regionalComment = String(formData.get("regionalComment") ?? "").trim() || null;
  if (reason.length < 3) return fail("Укажите причину изменения (обоснование для ГД).");

  // ---- one-time bonus (spec §7): NOT a scheme field → future PayrollAdjustment ----
  if (fieldType === "one_time_bonus") {
    const raw = String(formData.get("bonusAmount") ?? "").trim().replace(/\s/g, "").replace(",", ".");
    const rub = Number(raw);
    if (!Number.isFinite(rub) || rub <= 0) return fail("Укажите сумму разовой премии.");
    const bonusKopeks = Math.round(rub * 100);
    return createRequest(scope, {
      requestType: "period_adjustment",
      fieldType,
      targetField: "one_time_bonus",
      oldValueJson: null,
      proposedValueJson: JSON.stringify(bonusKopeks),
      calculatedImpactKopeks: bonusKopeks, // a bonus's impact IS its amount
      impactUncomputable: false,
      reason,
      regionalComment,
      effectiveFrom: null,
    });
  }

  // ---- scheme-field change (percentage / base_salary / threshold / tier) ----
  const targetField = String(formData.get("targetField") ?? "").trim();
  const spec = allowedFieldsForScheme(cc.schemeType).find((f) => f.key === targetField);
  if (!spec) return fail("Это поле недоступно для изменения региональным директором.");
  if (spec.fieldType !== fieldType) return fail("Тип изменения не соответствует выбранному полю.");

  let proposedValue: unknown;
  if (spec.unit === "tiers") {
    try {
      proposedValue = JSON.parse(String(formData.get("proposedTiersJson") ?? "[]"));
    } catch {
      return fail("Некорректный формат уровней процента.");
    }
  } else {
    const parsed = parseProposedScalar(spec.unit, formData.get("proposedValue"));
    if (!parsed.ok) return fail(parsed.error);
    proposedValue = parsed.value;
  }

  // Validate the proposed value by merging + re-validating the scheme (bounds check).
  const merged = applyOverridesToParams(cc.schemeType, cc.baseParams, [
    ...cc.overrides,
    { requestId: "validate", targetField, fieldType, value: proposedValue, appliedAt: "" },
  ]);
  if (!merged.ok) return fail(merged.error);

  const oldValue = currentFieldValue(cc, targetField);
  const preview = previewChangeImpact({
    schemeType: cc.schemeType,
    baseParams: cc.baseParams,
    input: cc.input,
    targetField,
    fieldType,
    proposedValue,
    existingOverrides: cc.overrides,
  });

  return createRequest(scope, {
    requestType: "period_adjustment",
    fieldType,
    targetField,
    oldValueJson: oldValue === undefined ? null : JSON.stringify(oldValue),
    proposedValueJson: JSON.stringify(proposedValue),
    calculatedImpactKopeks: preview.computable ? preview.differenceKopeks : null,
    impactUncomputable: !preview.computable,
    reason,
    regionalComment,
    effectiveFrom: null,
  });
}

/** Single entry point for the calc-page form: dispatch on requestType (spec §2). */
export async function proposeChange(prev: ChangeRequestState | undefined, formData: FormData): Promise<ChangeRequestState> {
  const requestType = String(formData.get("requestType") ?? "period_adjustment").trim();
  return requestType === "future_scheme_change"
    ? proposeFutureSchemeChange(prev, formData)
    : proposePeriodChange(prev, formData);
}

/**
 * Propose a FUTURE scheme change (spec §2.2, §10). Stored as a proposal only — approval
 * does NOT rewrite any past snapshot or a scheme already in use; it is marked
 * approved_pending_scheme_creation at review time (Variant B) so nothing is silently
 * claimed as applied.
 */
export async function proposeFutureSchemeChange(_prev: ChangeRequestState | undefined, formData: FormData): Promise<ChangeRequestState> {
  const calculationId = String(formData.get("calculationId") ?? "").trim();
  const scope = await resolveCalcScope(calculationId);
  if (!scope.ok) return fail(scope.error);
  if (!canProposePayrollChange(scope.ctx.effectiveRoles)) return fail("Только региональный директор может предложить изменение.");

  const cc = calcComputeContext(scope.calc);
  if (!cc) return fail("Схема оплаты не зафиксирована для этого расчёта.");

  const fieldType = String(formData.get("fieldType") ?? "").trim() as ChangeFieldType;
  const targetField = String(formData.get("targetField") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const effRaw = String(formData.get("effectiveFrom") ?? "").trim();
  if (reason.length < 3) return fail("Укажите причину изменения.");
  if (!effRaw) return fail("Укажите дату, с которой действует новая схема.");
  const effectiveFrom = new Date(`${effRaw}T00:00:00`);
  if (Number.isNaN(effectiveFrom.getTime())) return fail("Некорректная дата.");

  const spec = allowedFieldsForScheme(cc.schemeType).find((f) => f.key === targetField);
  if (!spec || spec.fieldType !== fieldType) return fail("Это поле недоступно для изменения.");

  let proposedValue: unknown;
  if (spec.unit === "tiers") {
    try {
      proposedValue = JSON.parse(String(formData.get("proposedTiersJson") ?? "[]"));
    } catch {
      return fail("Некорректный формат уровней процента.");
    }
  } else {
    const parsed = parseProposedScalar(spec.unit, formData.get("proposedValue"));
    if (!parsed.ok) return fail(parsed.error);
    proposedValue = parsed.value;
  }
  const merged = applyOverridesToParams(cc.schemeType, cc.baseParams, [{ requestId: "validate", targetField, fieldType, value: proposedValue, appliedAt: "" }]);
  if (!merged.ok) return fail(merged.error);

  // STAGE 13 (§21): scope of the future version — employee-specific or the whole category.
  const schemeScope = String(formData.get("schemeScope") ?? "employee").trim() === "payroll_category" ? "payroll_category" : "employee";

  return createRequest(scope, {
    requestType: "future_scheme_change",
    fieldType,
    targetField,
    oldValueJson: cc.baseParams[targetField] === undefined ? null : JSON.stringify(cc.baseParams[targetField]),
    proposedValueJson: JSON.stringify(proposedValue),
    calculatedImpactKopeks: null,
    impactUncomputable: true, // future scheme: impact depends on future periods
    reason,
    regionalComment: null,
    effectiveFrom,
    schemeScope,
  });
}

type CreateArgs = {
  requestType: ChangeRequestType;
  fieldType: ChangeFieldType;
  targetField: string;
  oldValueJson: string | null;
  proposedValueJson: string;
  calculatedImpactKopeks: number | null;
  impactUncomputable: boolean;
  reason: string;
  regionalComment: string | null;
  effectiveFrom: Date | null;
  schemeScope?: string | null;
};

async function createRequest(
  scope: { ctx: NonNullable<Awaited<ReturnType<typeof getCurrentAccessContext>>>; companyId: string; calc: { id: string; clubId: string; employeeId: string; payrollPeriodId: string; schemeSnapshotJson: string | null } },
  a: CreateArgs,
): Promise<ChangeRequestState> {
  const now = new Date();
  let schemeId: string | null = null;
  if (scope.calc.schemeSnapshotJson) {
    try {
      schemeId = (JSON.parse(scope.calc.schemeSnapshotJson) as { schemeId?: string }).schemeId ?? null;
    } catch {
      /* ignore */
    }
  }
  const history = appendHistory(null, { at: now.toISOString(), by: scope.ctx.user.id, action: "submitted", toStatus: "submitted", revision: 1 });
  const req = await prisma.payrollChangeRequest.create({
    data: {
      companyId: scope.companyId,
      clubId: scope.calc.clubId,
      employeeId: scope.calc.employeeId,
      payrollPeriodId: scope.calc.payrollPeriodId,
      payrollCalculationId: scope.calc.id,
      payrollSchemeId: schemeId,
      requestType: a.requestType,
      fieldType: a.fieldType,
      targetField: a.targetField,
      oldValueJson: a.oldValueJson,
      proposedValueJson: a.proposedValueJson,
      calculatedImpactKopeks: a.calculatedImpactKopeks,
      impactUncomputable: a.impactUncomputable,
      effectiveFrom: a.effectiveFrom,
      schemeScope: a.schemeScope ?? null,
      reason: a.reason,
      regionalComment: a.regionalComment,
      status: "submitted",
      revision: 1,
      historyJson: history,
      requestedById: scope.ctx.user.id,
      requestedAt: now,
      submittedAt: now,
    },
  });
  try {
    await recordAudit({ action: "payroll.change_request_submitted", entityType: "PayrollChangeRequest", entityId: req.id, companyId: scope.companyId, clubId: scope.calc.clubId, userId: scope.ctx.user.id, metadata: { requestType: a.requestType, fieldType: a.fieldType, targetField: a.targetField, impactKopeks: a.calculatedImpactKopeks } });
  } catch {
    /* ignore */
  }
  try {
    await notifyPayrollChangeReview({ resourceId: req.id, companyId: scope.companyId, clubId: scope.calc.clubId, amountKopeks: a.calculatedImpactKopeks ?? 0, actorUserId: scope.ctx.user.id, isResubmit: false });
  } catch {
    /* best-effort */
  }
  revalidatePath("/payroll/change-requests");
  revalidatePath(`/payroll/periods/${scope.calc.payrollPeriodId}`);
  return { ok: true, requestId: req.id, notice: "Предложение отправлено на согласование." };
}

// ---- regional: revise / cancel ---------------------------------------------

/** Cancel own request while it is still open (draft/submitted/under_review/returned). */
export async function cancelChangeRequest(_prev: ChangeRequestState | undefined, formData: FormData): Promise<ChangeRequestState> {
  const requestId = String(formData.get("requestId") ?? "").trim();
  const scope = await resolveRequestScope(requestId);
  if (!scope.ok) return fail(scope.error);
  const { req } = scope;
  const isOwner = req.requestedById === scope.ctx.user.id;
  if (!isOwner && !canReviewPayrollChange(scope.ctx.effectiveRoles)) return fail("Недостаточно прав.");
  if (!canTransition(req.status, "cancel")) return fail("Заявку в этом статусе нельзя отменить.");
  const now = new Date();
  await prisma.payrollChangeRequest.update({
    where: { id: req.id },
    data: { status: "cancelled", cancelledAt: now, historyJson: appendHistory(req.historyJson, { at: now.toISOString(), by: scope.ctx.user.id, action: "cancelled", fromStatus: req.status, toStatus: "cancelled" }) },
  });
  try {
    await recordAudit({ action: "payroll.change_request_cancelled", entityType: "PayrollChangeRequest", entityId: req.id, companyId: scope.companyId, clubId: req.clubId, userId: scope.ctx.user.id });
  } catch {
    /* ignore */
  }
  revalidatePath("/payroll/change-requests");
  return { ok: true, requestId: req.id, notice: "Заявка отменена." };
}

/** Regional resubmits a returned request with a new revision (spec §13). */
export async function resubmitChangeRequest(_prev: ChangeRequestState | undefined, formData: FormData): Promise<ChangeRequestState> {
  const requestId = String(formData.get("requestId") ?? "").trim();
  const scope = await resolveRequestScope(requestId);
  if (!scope.ok) return fail(scope.error);
  const { req } = scope;
  if (req.requestedById !== scope.ctx.user.id) return fail("Изменить и повторно отправить может только автор.");
  if (!canTransition(req.status, "resubmit")) return fail("Повторно отправить можно только возвращённую заявку.");
  const regionalComment = String(formData.get("regionalComment") ?? "").trim() || req.regionalComment;

  // Recompute impact against the CURRENT calc state (base + already-approved overrides).
  let calculatedImpactKopeks = req.calculatedImpactKopeks;
  let impactUncomputable = req.impactUncomputable;
  if (req.payrollCalculationId && req.fieldType !== "one_time_bonus") {
    const calc = await prisma.payrollCalculation.findUnique({ where: { id: req.payrollCalculationId } });
    const cc = calc ? calcComputeContext(calc) : null;
    if (cc && req.targetField) {
      const preview = previewChangeImpact({ schemeType: cc.schemeType, baseParams: cc.baseParams, input: cc.input, targetField: req.targetField, fieldType: req.fieldType as ChangeFieldType, proposedValue: JSON.parse(req.proposedValueJson), existingOverrides: cc.overrides });
      calculatedImpactKopeks = preview.computable ? preview.differenceKopeks : null;
      impactUncomputable = !preview.computable;
    }
  }

  const now = new Date();
  const revision = req.revision + 1;
  await prisma.payrollChangeRequest.update({
    where: { id: req.id },
    data: {
      status: "submitted",
      revision,
      regionalComment,
      calculatedImpactKopeks,
      impactUncomputable,
      submittedAt: now,
      reviewerComment: null,
      historyJson: appendHistory(req.historyJson, { at: now.toISOString(), by: scope.ctx.user.id, action: "resubmitted", fromStatus: req.status, toStatus: "submitted", revision }),
    },
  });
  try {
    await notifyPayrollChangeReview({ resourceId: req.id, companyId: scope.companyId, clubId: req.clubId, amountKopeks: calculatedImpactKopeks ?? 0, actorUserId: scope.ctx.user.id, isResubmit: true });
  } catch {
    /* best-effort */
  }
  revalidatePath("/payroll/change-requests");
  return { ok: true, requestId: req.id, notice: "Заявка повторно отправлена на согласование." };
}

// ---- reviewer: return / reject / approve (spec §12–§15) --------------------

async function resolveReviewer(requestId: string) {
  const scope = await resolveRequestScope(requestId);
  if (!scope.ok) return scope;
  if (!canReviewPayrollChange(scope.ctx.effectiveRoles)) return { ok: false as const, error: "Согласование доступно только ГД или собственнику." };
  // Cannot review your own proposal (§18/§19).
  if (scope.req.requestedById === scope.ctx.user.id) return { ok: false as const, error: "Нельзя согласовать собственную заявку." };
  return scope;
}

/** Return a request for revision, keeping the full revision history (spec §13). */
export async function returnChangeRequest(_prev: ChangeRequestState | undefined, formData: FormData): Promise<ChangeRequestState> {
  const requestId = String(formData.get("requestId") ?? "").trim();
  const scope = await resolveReviewer(requestId);
  if (!scope.ok) return fail(scope.error);
  const { req } = scope;
  if (!canTransition(req.status, "return")) return fail("Вернуть можно только заявку на согласовании.");
  const comment = String(formData.get("comment") ?? "").trim();
  if (comment.length < 3) return fail("Укажите, что нужно доработать.");
  const now = new Date();
  await prisma.payrollChangeRequest.update({
    where: { id: req.id },
    data: { status: "returned_for_revision", reviewedById: scope.ctx.user.id, reviewedAt: now, returnedAt: now, reviewerComment: comment, historyJson: appendHistory(req.historyJson, { at: now.toISOString(), by: scope.ctx.user.id, action: "returned", fromStatus: req.status, toStatus: "returned_for_revision", comment }) },
  });
  try {
    await recordAudit({ action: "payroll.change_request_returned", entityType: "PayrollChangeRequest", entityId: req.id, companyId: scope.companyId, clubId: req.clubId, userId: scope.ctx.user.id });
    await notifyPayrollChangeDecision({ resourceId: req.id, companyId: scope.companyId, clubId: req.clubId, amountKopeks: req.calculatedImpactKopeks ?? 0, authorUserId: req.requestedById, actorUserId: scope.ctx.user.id, event: "returned" });
  } catch {
    /* ignore */
  }
  revalidatePath("/payroll/change-requests");
  return { ok: true, requestId: req.id, notice: "Заявка возвращена на доработку." };
}

/** Reject a request (terminal, read-only, no calc change — spec §14). */
export async function rejectChangeRequest(_prev: ChangeRequestState | undefined, formData: FormData): Promise<ChangeRequestState> {
  const requestId = String(formData.get("requestId") ?? "").trim();
  const scope = await resolveReviewer(requestId);
  if (!scope.ok) return fail(scope.error);
  const { req } = scope;
  if (!canTransition(req.status, "reject")) return fail("Отклонить можно только заявку на согласовании.");
  const comment = String(formData.get("comment") ?? "").trim();
  if (comment.length < 3) return fail("Укажите причину отклонения.");
  const now = new Date();
  await prisma.payrollChangeRequest.update({
    where: { id: req.id },
    data: { status: "rejected", reviewedById: scope.ctx.user.id, reviewedAt: now, rejectedAt: now, reviewerComment: comment, historyJson: appendHistory(req.historyJson, { at: now.toISOString(), by: scope.ctx.user.id, action: "rejected", fromStatus: req.status, toStatus: "rejected", comment }) },
  });
  try {
    await recordAudit({ action: "payroll.change_request_rejected", entityType: "PayrollChangeRequest", entityId: req.id, companyId: scope.companyId, clubId: req.clubId, userId: scope.ctx.user.id });
    await notifyPayrollChangeDecision({ resourceId: req.id, companyId: scope.companyId, clubId: req.clubId, amountKopeks: req.calculatedImpactKopeks ?? 0, authorUserId: req.requestedById, actorUserId: scope.ctx.user.id, event: "rejected" });
  } catch {
    /* ignore */
  }
  revalidatePath("/payroll/change-requests");
  return { ok: true, requestId: req.id, notice: "Заявка отклонена." };
}

/**
 * APPROVE + APPLY (spec §6, §15). Transactional and IDEMPOTENT: the request is CLAIMED
 * by atomically setting a unique appliedToken under a status precondition, so a
 * double-approve applies the change exactly once. Then the effect is materialised:
 *   one_time_bonus  → one approved PayrollAdjustment (bonus), no money movement (§7)
 *   percentage/base/threshold/tier → an approved override on the calc, snapshot untouched;
 *                     the automatic amount is recomputed from the EFFECTIVE scheme (§6)
 *   future_scheme_change → approved_pending_scheme_creation, no calc change (§10 Variant B)
 */
export async function approveChangeRequest(_prev: ChangeRequestState | undefined, formData: FormData): Promise<ChangeRequestState> {
  const requestId = String(formData.get("requestId") ?? "").trim();
  const scope = await resolveReviewer(requestId);
  if (!scope.ok) return fail(scope.error);
  const { req } = scope;
  if (!canTransition(req.status, "approve")) return fail("Согласовать можно только заявку на согласовании.");

  // Closed-period protection (§16): a period_adjustment cannot be applied to a closed period.
  if (req.requestType === "period_adjustment" && req.payrollPeriodId) {
    const period = await prisma.payrollPeriod.findUnique({ where: { id: req.payrollPeriodId }, select: { status: true } });
    if (period && isPayrollPeriodClosed(period.status)) return fail("Период закрыт — применить изменение нельзя.");
  }

  const now = new Date();
  const token = `apply:${req.id}`;
  // Atomic claim: unique appliedToken + status precondition → exactly-once (§15).
  const claim = await prisma.payrollChangeRequest.updateMany({
    where: { id: req.id, status: { in: ["submitted", "under_review"] }, appliedToken: null },
    data: { appliedToken: token, reviewedById: scope.ctx.user.id, reviewedAt: now },
  });
  if (claim.count === 0) return fail("Заявка уже обработана.");

  const comment = String(formData.get("comment") ?? "").trim() || null;
  let notice = "Изменение согласовано и применено.";
  let finalStatus = "applied";
  let appliedAdjustmentId: string | null = null;

  try {
    if (req.requestType === "future_scheme_change") {
      // Variant B (§10): approved, but the versioned-scheme creation is a later stage.
      finalStatus = "approved_pending_scheme_creation";
      notice = "Будущая схема согласована. Создание новой схемы выполняется отдельно (не затрагивает прошлые расчёты).";
    } else if (req.fieldType === "one_time_bonus" && req.payrollCalculationId) {
      const bonusKopeks = Number(JSON.parse(req.proposedValueJson));
      const adj = await prisma.payrollAdjustment.create({
        data: {
          companyId: req.companyId,
          payrollCalculationId: req.payrollCalculationId,
          employeeId: req.employeeId ?? "",
          clubId: req.clubId,
          type: "bonus",
          direction: "credit",
          amountKopeks: bonusKopeks,
          reason: `Разовая премия (согласовано ГД): ${req.reason}`,
          comment: comment ?? req.regionalComment,
          status: "approved",
          createdByUserId: req.requestedById,
          approvedByUserId: scope.ctx.user.id,
        },
      });
      appliedAdjustmentId = adj.id;
      await recomputeCalculationTotals(req.payrollCalculationId);
    } else if (req.payrollCalculationId && req.targetField) {
      // Scheme-field override → merge onto the calc, recompute from the effective scheme.
      const calc = await prisma.payrollCalculation.findUnique({ where: { id: req.payrollCalculationId } });
      if (!calc) throw new Error("calc_missing");
      const check = assertFieldAllowed(JSON.parse(calc.schemeSnapshotJson ?? "{}").schemeType ?? "", req.targetField, req.fieldType as ChangeFieldType);
      if (!check.ok) throw new Error(check.error);
      const overrides = parseApprovedOverrides(calc.approvedOverridesJson).overrides;
      overrides.push({ requestId: req.id, targetField: req.targetField, fieldType: req.fieldType as ChangeFieldType, value: JSON.parse(req.proposedValueJson), appliedAt: now.toISOString() });
      await prisma.payrollCalculation.update({ where: { id: calc.id }, data: { approvedOverridesJson: JSON.stringify({ overrides }) } });
      await recomputeCalcFromEffective(calc.id);
    }

    await prisma.payrollChangeRequest.update({
      where: { id: req.id },
      data: {
        status: finalStatus,
        reviewerComment: comment ?? req.reviewerComment,
        appliedById: scope.ctx.user.id,
        appliedAt: finalStatus === "applied" ? now : null,
        appliedAdjustmentId,
        historyJson: appendHistory(req.historyJson, { at: now.toISOString(), by: scope.ctx.user.id, action: "approved", fromStatus: req.status, toStatus: finalStatus, comment: comment ?? undefined }),
      },
    });
  } catch (e) {
    // Roll the claim back so the request can be retried (nothing was applied on this path).
    await prisma.payrollChangeRequest.update({ where: { id: req.id }, data: { appliedToken: null } }).catch(() => {});
    return fail(`Не удалось применить изменение: ${(e as Error).message}`);
  }

  // STAGE 12 (§8/§15): a future scheme change now materialises a REAL new PayrollScheme
  // version immediately after approval. Idempotent; on failure the request stays
  // approved_pending_scheme_creation for a safe retry (never a partial second version).
  if (req.requestType === "future_scheme_change") {
    const mat = await materializeApprovedSchemeChange(req.id, scope.ctx.user.id, now);
    if (mat.ok) {
      finalStatus = "applied";
      notice = mat.alreadyExisted ? "Изменение согласовано; версия схемы уже была создана." : "Изменение согласовано — создана новая версия схемы с указанной даты.";
    } else {
      notice = `Изменение согласовано, но версия схемы не создана: ${mat.error}. Повторите материализацию на карточке заявки.`;
    }
  }

  try {
    await recordAudit({ action: "payroll.change_request_approved", entityType: "PayrollChangeRequest", entityId: req.id, companyId: scope.companyId, clubId: req.clubId, userId: scope.ctx.user.id, metadata: { requestType: req.requestType, fieldType: req.fieldType, targetField: req.targetField, finalStatus, appliedAdjustmentId } });
    await notifyPayrollChangeDecision({ resourceId: req.id, companyId: scope.companyId, clubId: req.clubId, amountKopeks: req.calculatedImpactKopeks ?? 0, authorUserId: req.requestedById, actorUserId: scope.ctx.user.id, event: "approved" });
  } catch {
    /* ignore */
  }
  revalidatePath("/payroll/change-requests");
  if (req.payrollPeriodId) revalidatePath(`/payroll/periods/${req.payrollPeriodId}`);
  return { ok: true, requestId: req.id, notice };
}

/**
 * Retry materialising an approved future scheme change (spec §15) when the automatic
 * attempt at approval time failed. Idempotent — never creates a second version.
 */
export async function retryMaterializeSchemeChange(_prev: ChangeRequestState | undefined, formData: FormData): Promise<ChangeRequestState> {
  const requestId = String(formData.get("requestId") ?? "").trim();
  const base = await ctxScope();
  if (!base.ok) return fail(base.error);
  const req = await prisma.payrollChangeRequest.findUnique({ where: { id: requestId } });
  if (!req || req.companyId !== base.companyId || !base.clubIds.includes(req.clubId)) return fail("Заявка не найдена");
  if (!canReviewPayrollChange(base.ctx.effectiveRoles)) return fail("Материализация доступна только ГД или собственнику.");
  const mat = await materializeApprovedSchemeChange(req.id, base.ctx.user.id, new Date());
  if (!mat.ok) return fail(mat.error);
  try {
    await recordAudit({ action: "payroll.scheme_version_materialized", entityType: "EmployeePayScheme", entityId: mat.scheme.id, companyId: req.companyId, clubId: req.clubId, userId: base.ctx.user.id, metadata: { requestId, version: mat.scheme.version, alreadyExisted: mat.alreadyExisted } });
  } catch {
    /* ignore */
  }
  revalidatePath("/payroll/change-requests");
  revalidatePath("/payroll/schemes");
  return { ok: true, requestId: req.id, notice: mat.alreadyExisted ? "Версия схемы уже была создана." : "Новая версия схемы создана." };
}

/**
 * Recompute a calc's automatic amount from its EFFECTIVE scheme (snapshot + approved
 * overrides) and the stored inputs. Gym-trainer calcs recompute from their packages.
 */
async function recomputeCalcFromEffective(calculationId: string): Promise<void> {
  const calc = await prisma.payrollCalculation.findUnique({ where: { id: calculationId } });
  if (!calc) return;
  const scheme = effectiveSchemeParams(calc.schemeSnapshotJson, calc.approvedOverridesJson);
  if (!scheme) return;
  if (scheme.type === "gym_trainer") {
    await recomputeGymTrainerCalculation(calc.id);
    return;
  }
  const cc = calcComputeContext(calc);
  const result = computeScheme(scheme, cc?.input ?? {});
  const prevDetails = (() => {
    try {
      return calc.detailsJson ? (JSON.parse(calc.detailsJson) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();
  await prisma.payrollCalculation.update({
    where: { id: calc.id },
    data: {
      automaticAmountKopeks: result.amountKopeks,
      detailsJson: JSON.stringify({ ...prevDetails, breakdown: result.breakdown, flags: result.flags, warnings: result.warnings }),
    },
  });
  await recomputeCalculationTotals(calc.id);
}
