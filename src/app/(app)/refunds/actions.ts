"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canCreateOperational, canMutateOperationalRecords, STRATEGIC_READONLY_ERROR } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, canAccessClub, recordAudit, hasActiveRegionalApproverForClub } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { isUploadedFile, type UploadedFile } from "@/lib/uploaded-file";
import { getRefundForContext, REFUND_ACTION_AUDIT, type RefundDocument } from "@/lib/refunds";
import {
  applyApprovalAction,
  canEditApproval,
  type ApprovalAction,
} from "@/lib/approval";
import {
  analyzeRefundDocuments,
  manualRefundExtraction,
  type RefundExtraction,
} from "@/lib/ai/refund-analyzer";
import {
  validateRefundFile,
  storeRefundFile,
  MAX_REFUND_FILES,
} from "@/lib/refund-storage";

type AnalyzeState = {
  ok: boolean;
  error?: string;
  clubId?: string;
  documents?: RefundDocument[];
  extraction?: RefundExtraction;
};

type SaveState = { ok: boolean; error?: string; refundId?: string };

const DOC_TYPES = new Set(["contract", "statement", "requisites", "receipt", "other"]);

function str(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? "").trim();
  return v || null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type ParsedFields = {
  clientName: string | null;
  clientPhone: string | null;
  amountKopeks: number;
  currency: string;
  reason: string | null;
  contractNumber: string | null;
  refundDate: Date | null;
  bankRecipientName: string | null;
  bankName: string | null;
  bankBik: string | null;
  bankAccount: string | null;
  notes: string | null;
};

function parseRefundFields(formData: FormData): { data?: ParsedFields; error?: string } {
  const amountRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const amount = amountRaw === "" ? 0 : Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "Сумма должна быть неотрицательным числом" };
  }
  return {
    data: {
      clientName: str(formData, "clientName"),
      clientPhone: str(formData, "clientPhone"),
      amountKopeks: rublesToKopeks(amount),
      currency: str(formData, "currency") ?? "RUB",
      reason: str(formData, "reason"),
      contractNumber: str(formData, "contractNumber"),
      refundDate: parseDate(str(formData, "refundDate")),
      bankRecipientName: str(formData, "bankRecipientName"),
      bankName: str(formData, "bankName"),
      bankBik: str(formData, "bankBik"),
      bankAccount: str(formData, "bankAccount"),
      notes: str(formData, "notes"),
    },
  };
}

async function clubCompanyId(clubId: string): Promise<string | null> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  return club?.companyId ?? null;
}

export async function uploadAndAnalyzeRefund(
  _prev: AnalyzeState | undefined,
  formData: FormData,
): Promise<AnalyzeState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "refunds")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return { ok: false, error: "Создавать возвраты могут управляющие и региональные директора" };
  }

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }

  const docTypeRaw = String(formData.get("docType") ?? "other").trim();
  const docType = DOC_TYPES.has(docTypeRaw) ? docTypeRaw : "other";

  const rawFiles: UploadedFile[] = [];
  for (const entry of formData.getAll("files")) {
    if (isUploadedFile(entry) && entry.size > 0) rawFiles.push(entry);
  }
  if (rawFiles.length > MAX_REFUND_FILES) {
    return { ok: false, error: `Не более ${MAX_REFUND_FILES} файлов за раз` };
  }

  if (rawFiles.length === 0) {
    return { ok: true, clubId, documents: [], extraction: manualRefundExtraction() };
  }

  const documents: RefundDocument[] = [];
  const inputs = [];
  for (const file of rawFiles) {
    const fileError = validateRefundFile(file);
    if (fileError) return { ok: false, error: `${file.name}: ${fileError}` };
    const stored = await storeRefundFile(file);
    documents.push({
      storageKey: stored.storageKey,
      fileName: stored.fileName,
      mime: stored.mime,
      size: stored.size,
      type: docType,
    });
    inputs.push({ buffer: stored.buffer, mime: stored.mime, fileName: stored.fileName });
  }

  const extraction = await analyzeRefundDocuments(inputs);

  await recordAudit({
    action: "refund.uploaded",
    entityType: "Refund",
    companyId: ctx.selectedCompanyId,
    clubId,
    userId: ctx.user.id,
    metadata: { count: documents.length, docType },
  });
  await recordAudit({
    action: "refund.extracted",
    entityType: "Refund",
    companyId: ctx.selectedCompanyId,
    clubId,
    userId: ctx.user.id,
    metadata: { confidence: extraction.confidence },
  });

  return { ok: true, clubId, documents, extraction };
}

export async function saveRefund(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "refunds")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return { ok: false, error: "Создавать возвраты могут управляющие и региональные директора" };
  }

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }
  const companyId = await clubCompanyId(clubId);
  if (!companyId || companyId !== ctx.selectedCompanyId) {
    return { ok: false, error: "Клуб не найден" };
  }

  const parsed = parseRefundFields(formData);
  if (parsed.error || !parsed.data) return { ok: false, error: parsed.error ?? "Ошибка данных" };

  // Block mutations in a closed accounting month (same guard as expenses/invoices).
  const closedSave = await monthClosedError(companyId, clubId, parsed.data.refundDate ?? new Date());
  if (closedSave) return { ok: false, error: closedSave };

  const confidenceRaw = String(formData.get("confidence") ?? "low");
  const confidence = ["low", "medium", "high"].includes(confidenceRaw) ? confidenceRaw : "low";

  const refund = await prisma.refund.create({
    data: {
      companyId,
      clubId,
      createdByUserId: ctx.user.id,
      ...parsed.data,
      status: "draft",
      confidence,
      documentsJson: str(formData, "documentsJson"),
      rawExtractedJson: str(formData, "rawExtractedJson"),
    },
  });

  await recordAudit({
    action: "refund.created",
    entityType: "Refund",
    entityId: refund.id,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { amountKopeks: refund.amountKopeks },
  });

  revalidatePath("/refunds");
  return { ok: true, refundId: refund.id };
}

export async function updateRefund(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "refunds")) {
    return { ok: false, error: "Нет доступа" };
  }

  // Strategic roles (owner / GD) view refunds but never edit them.
  if (!canMutateOperationalRecords(ctx.effectiveRoles)) {
    return { ok: false, error: STRATEGIC_READONLY_ERROR };
  }

  const refundId = String(formData.get("refundId") ?? "").trim();
  const existing = await getRefundForContext(ctx, refundId);
  if (!existing) return { ok: false, error: "Возврат не найден или нет доступа" };
  if (!canEditApproval(existing.status, ctx.effectiveRoles)) {
    return { ok: false, error: "Оплаченный возврат может редактировать только бухгалтер" };
  }

  const closedUpd = await monthClosedError(existing.companyId, existing.clubId, existing.paidAt ?? existing.refundDate ?? existing.createdAt);
  if (closedUpd) return { ok: false, error: closedUpd };

  const parsed = parseRefundFields(formData);
  if (parsed.error || !parsed.data) return { ok: false, error: parsed.error ?? "Ошибка данных" };

  await prisma.refund.update({ where: { id: refundId }, data: parsed.data });

  await recordAudit({
    action: "refund.updated",
    entityType: "Refund",
    entityId: refundId,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
  });

  revalidatePath("/refunds");
  revalidatePath(`/refunds/${refundId}`);
  return { ok: true, refundId };
}

export async function transitionRefund(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "refunds")) {
    throw new Error("Нет доступа");
  }

  const refundId = String(formData.get("refundId") ?? "").trim();
  const action = String(formData.get("action") ?? "").trim() as ApprovalAction;
  if (!(action in REFUND_ACTION_AUDIT)) throw new Error("Неверное действие");

  const existing = await getRefundForContext(ctx, refundId);
  if (!existing) throw new Error("Возврат не найден или нет доступа");

  const closedTx = await monthClosedError(existing.companyId, existing.clubId, existing.paidAt ?? existing.refundDate ?? existing.createdAt);
  if (closedTx) throw new Error(closedTx);

  const hasActiveRegional = await hasActiveRegionalApproverForClub(existing.companyId, existing.clubId);
  const isCreator = existing.createdByUserId === ctx.user.id;
  const result = applyApprovalAction(action, existing.status, ctx.effectiveRoles, { hasActiveRegional, isCreator });
  if (!result.ok) {
    if (action === "approve" || action === "reject") {
      await recordAudit({
        action: "refund.approval_blocked",
        entityType: "Refund",
        entityId: refundId,
        companyId: existing.companyId,
        clubId: existing.clubId,
        userId: ctx.user.id,
        metadata: { from: existing.status, action, fallbackAvailable: !hasActiveRegional, reason: result.error },
      });
    }
    throw new Error(result.error);
  }

  // Compare-and-set on the exact current status: a stale/duplicate submit updates
  // 0 rows and gets a clear message instead of double-applying the transition.
  const updated = await prisma.refund.updateMany({
    where: { id: refundId, status: existing.status },
    data: { status: result.to, paidAt: result.to === "paid" ? new Date() : null },
  });
  if (updated.count === 0) throw new Error("Статус возврата уже изменён. Обновите страницу.");

  const approverRole = hasActiveRegional ? "regional_director" : "chief_accountant";
  const auditAction =
    action === "approve"
      ? result.to === "approved_by_chief_accountant"
        ? "refund.approved_by_chief_accountant"
        : "refund.approved_by_regional"
      : action === "reject"
        ? hasActiveRegional
          ? "refund.rejected_by_regional"
          : "refund.rejected_by_chief_accountant"
        : REFUND_ACTION_AUDIT[action];

  await recordAudit({
    action: auditAction,
    entityType: "Refund",
    entityId: refundId,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
    metadata: {
      from: existing.status,
      to: result.to,
      action,
      ...(action === "approve" || action === "reject" ? { approverRole, fallbackUsed: !hasActiveRegional } : {}),
    },
  });

  revalidatePath("/refunds");
  revalidatePath(`/refunds/${refundId}`);
}
