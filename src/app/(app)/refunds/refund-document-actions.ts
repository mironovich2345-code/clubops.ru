"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canCreateOperational } from "@/lib/auth";
import { getCurrentAccessContext, canAccessClub, recordAudit } from "@/lib/access";
import { getStorage } from "@/lib/storage";
import { isUploadedFile } from "@/lib/uploaded-file";
import { getRefundForContext, getActiveRefundDocuments } from "@/lib/refunds";
import {
  isRefundReturnType, isValidRefundDocumentType, refundSlots, isRefundDocumentSetComplete,
  validateRefundRequisites, normalizeRequisitesPartial, maskDigits,
} from "@/lib/refund-documents";
import {
  MAX_REFUND_DOC_AGGREGATE, validateDeclaredRefundDoc, validateRefundSignature,
  storeRefundDocument, safeFilename, sha256Hex, refundDocError,
} from "@/lib/refund-document-storage";

type State = { ok: boolean; error?: string; refundId?: string };

type Ctx = NonNullable<Awaited<ReturnType<typeof getCurrentAccessContext>>>;
type RefundCtx = NonNullable<Awaited<ReturnType<typeof getRefundForContext>>>;

async function clubCompanyId(clubId: string): Promise<string | null> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  return club?.companyId ?? null;
}

// Object-scoped guard for editing a v2 DRAFT: company/club (via context), role,
// author-or-regional, correct version + status. Returns an error code or the row.
async function guardEditableDraft(refundId: string): Promise<{ ok: true; ctx: Ctx; refund: RefundCtx } | { ok: false; code: string }> {
  const ctx = await getCurrentAccessContext();
  if (!ctx) return { ok: false, code: "ACCESS_DENIED" };
  const refund = await getRefundForContext(ctx, refundId); // company + allowed-clubs check
  if (!refund) return { ok: false, code: "ACCESS_DENIED" };
  if (refund.entryVersion !== 2) return { ok: false, code: "NOT_EDITABLE" };
  if (refund.status !== "draft") return { ok: false, code: "NOT_EDITABLE" };
  if (!canCreateOperational(ctx.effectiveRoles)) return { ok: false, code: "ACCESS_DENIED" };
  const isCreator = refund.createdByUserId === ctx.user.id;
  const isRegional = ctx.effectiveRoles.includes("regional_director");
  if (!isCreator && !isRegional) return { ok: false, code: "ACCESS_DENIED" };
  return { ok: true, ctx, refund };
}

/** Create a v2 refund draft with a required, validated return type. */
export async function createRefundDraft(_prev: State | undefined, formData: FormData): Promise<State> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canCreateOperational(ctx.effectiveRoles)) return { ok: false, error: "Нет прав на создание возврата." };
  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) return { ok: false, error: "Нет доступа к выбранному клубу." };
  const companyId = await clubCompanyId(clubId);
  if (!companyId || companyId !== ctx.selectedCompanyId) return { ok: false, error: "Клуб не найден." };
  const returnType = String(formData.get("returnType") ?? "").trim();
  if (!returnType) return { ok: false, error: "Выберите тип возврата." };
  if (!isRefundReturnType(returnType)) return { ok: false, error: "Недопустимый тип возврата." };

  const refund = await prisma.refund.create({
    data: { companyId, clubId, createdByUserId: ctx.user.id, entryVersion: 2, returnType, status: "draft", confidence: "low" },
    select: { id: true },
  });
  await recordAudit({ action: "refund.draft_created", entityType: "Refund", entityId: refund.id, companyId, clubId, userId: ctx.user.id, metadata: { returnType } });
  revalidatePath("/refunds");
  return { ok: true, refundId: refund.id };
}

/** Change the draft's return type; soft-remove documents whose slot is now invalid. */
export async function changeRefundType(_prev: State | undefined, formData: FormData): Promise<State> {
  const refundId = String(formData.get("refundId") ?? "").trim();
  const g = await guardEditableDraft(refundId);
  if (!g.ok) return { ok: false, error: refundDocError(g.code) };
  const { ctx, refund } = g;
  const newType = String(formData.get("returnType") ?? "").trim();
  if (!isRefundReturnType(newType)) return { ok: false, error: "Недопустимый тип возврата." };
  if (newType === refund.returnType) return { ok: true, refundId };

  const validKeys = new Set(refundSlots(newType).map((s) => s.key));
  const active = await getActiveRefundDocuments(refundId);
  const toRemove = active.filter((d) => !validKeys.has(d.documentType));
  await prisma.$transaction(async (tx) => {
    for (const d of toRemove) {
      await tx.refundDocument.updateMany({ where: { id: d.id, removedAt: null }, data: { removedAt: new Date(), removedByUserId: ctx.user.id, removalReason: "type_changed", activeSlotKey: null } });
    }
    await tx.refund.update({ where: { id: refundId }, data: { returnType: newType } });
  });
  await recordAudit({ action: "refund.type_changed", entityType: "Refund", entityId: refundId, companyId: refund.companyId, clubId: refund.clubId, userId: ctx.user.id, metadata: { from: refund.returnType, to: newType, removedDocuments: toRemove.length } });
  revalidatePath(`/refunds/new/${refundId}`);
  return { ok: true, refundId };
}

type UploadState = { ok: boolean; error?: string };

/** Upload exactly one document into a slot (replaces any current active one). */
export async function uploadRefundDocument(_prev: UploadState | undefined, formData: FormData): Promise<UploadState> {
  const refundId = String(formData.get("refundId") ?? "").trim();
  const g = await guardEditableDraft(refundId);
  if (!g.ok) return { ok: false, error: refundDocError(g.code) };
  const { ctx, refund } = g;

  const documentType = String(formData.get("documentType") ?? "").trim();
  if (!refund.returnType || !isValidRefundDocumentType(refund.returnType, documentType)) return { ok: false, error: refundDocError("SLOT_INVALID") };

  const files = (formData.getAll("file") as unknown[]).filter(isUploadedFile);
  const file = files[0];
  if (!file) return { ok: false, error: refundDocError("FILE_EMPTY") };

  const declared = validateDeclaredRefundDoc(file);
  if (!declared.ok) return { ok: false, error: refundDocError(declared.code) };

  let buffer: Buffer;
  try { buffer = Buffer.from(await file.arrayBuffer()); } catch { return { ok: false, error: refundDocError("FILE_INVALID") }; }
  const sig = validateRefundSignature(buffer, file.type);
  if (!sig.ok) return { ok: false, error: refundDocError(sig.code) };

  // Aggregate cap: replacing the same slot frees its current bytes.
  const active = await getActiveRefundDocuments(refundId);
  const aggregateExcludingSlot = active.filter((d) => d.documentType !== documentType).reduce((s, d) => s + d.sizeBytes, 0);
  if (aggregateExcludingSlot + buffer.length > MAX_REFUND_DOC_AGGREGATE) return { ok: false, error: refundDocError("AGGREGATE_EXCEEDED") };

  let stored;
  try { stored = await storeRefundDocument(buffer, file.type); } catch { return { ok: false, error: refundDocError("STORAGE_FAILED") }; }

  const activeSlotKey = `${refundId}:${documentType}`;
  let created: { id: string } | null = null;
  try {
    created = await prisma.$transaction(async (tx) => {
      // Soft-remove any current active file in this slot, then create the new
      // one. The unique activeSlotKey guarantees only ONE active per slot and
      // makes overlapping uploads safe (SQLite serializes writers).
      await tx.refundDocument.updateMany({ where: { refundId, documentType, removedAt: null }, data: { removedAt: new Date(), removedByUserId: ctx.user.id, removalReason: "replaced", activeSlotKey: null } });
      return tx.refundDocument.create({
        data: {
          refundId, companyId: refund.companyId, clubId: refund.clubId, documentType,
          storageKey: stored!.storageKey, originalFilename: file.name.slice(0, 255), safeFilename: safeFilename(file.name),
          mimeType: file.type, sizeBytes: stored!.sizeBytes, sha256: sha256Hex(buffer), uploadedByUserId: ctx.user.id, activeSlotKey,
        },
        select: { id: true },
      });
    });
  } catch { created = null; }
  if (!created) {
    await getStorage().delete(stored.storageKey).catch(() => {}); // orphan cleanup
    return { ok: false, error: refundDocError("SLOT_CONFLICT") };
  }
  await recordAudit({ action: "refund.document_uploaded", entityType: "RefundDocument", entityId: created.id, companyId: refund.companyId, clubId: refund.clubId, userId: ctx.user.id, metadata: { refundId, returnType: refund.returnType, documentType, sizeBytes: stored.sizeBytes, mimeCategory: file.type.split("/")[0] } });
  revalidatePath(`/refunds/new/${refundId}`);
  return { ok: true };
}

type RemoveState = { ok: boolean; error?: string };

/** Soft-remove one active slot document (reason required). Idempotent. */
export async function removeRefundDocument(_prev: RemoveState | undefined, formData: FormData): Promise<RemoveState> {
  const refundId = String(formData.get("refundId") ?? "").trim();
  const documentId = String(formData.get("documentId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const g = await guardEditableDraft(refundId);
  if (!g.ok) return { ok: false, error: refundDocError(g.code) };
  const { ctx, refund } = g;
  if (!reason) return { ok: false, error: refundDocError("REASON_REQUIRED") };

  const doc = await prisma.refundDocument.findUnique({ where: { id: documentId }, select: { refundId: true, removedAt: true } });
  if (!doc || doc.refundId !== refundId) return { ok: false, error: refundDocError("NOT_FOUND") };
  if (doc.removedAt) return { ok: true }; // idempotent

  const res = await prisma.refundDocument.updateMany({ where: { id: documentId, removedAt: null }, data: { removedAt: new Date(), removedByUserId: ctx.user.id, removalReason: reason.slice(0, 300), activeSlotKey: null } });
  if (res.count === 0) return { ok: true }; // concurrent → idempotent
  await recordAudit({ action: "refund.document_removed", entityType: "RefundDocument", entityId: documentId, companyId: refund.companyId, clubId: refund.clubId, userId: ctx.user.id, metadata: { refundId, reason: reason.slice(0, 120) } });
  revalidatePath(`/refunds/new/${refundId}`);
  return { ok: true };
}

/** Validate + normalize + store the five bank requisites. */
export async function saveRefundRequisites(_prev: State | undefined, formData: FormData): Promise<State> {
  const refundId = String(formData.get("refundId") ?? "").trim();
  const g = await guardEditableDraft(refundId);
  if (!g.ok) return { ok: false, error: refundDocError(g.code) };
  const { ctx, refund } = g;

  // Draft save allows a PARTIAL requisites block (missing fields ok); a provided
  // numeric field must be well-formed. Full presence is required only at «Далее».
  const v = normalizeRequisitesPartial({
    bankRecipientName: String(formData.get("bankRecipientName") ?? ""),
    bankName: String(formData.get("bankName") ?? ""),
    bankBik: String(formData.get("bankBik") ?? ""),
    bankAccount: String(formData.get("bankAccount") ?? ""),
    bankCorrAccount: String(formData.get("bankCorrAccount") ?? ""),
  });
  if (!v.ok) return { ok: false, error: v.error };

  await prisma.refund.update({ where: { id: refundId }, data: v.data });
  await recordAudit({
    action: "refund.requisites_updated", entityType: "Refund", entityId: refundId,
    companyId: refund.companyId, clubId: refund.clubId, userId: ctx.user.id,
    metadata: { bik: maskDigits(v.data.bankBik), account: maskDigits(v.data.bankAccount), corrAccount: maskDigits(v.data.bankCorrAccount) },
  });
  revalidatePath(`/refunds/new/${refundId}`);
  return { ok: true, refundId };
}

/** Soft-cancel a draft (status → canceled). Never a hard delete. */
export async function cancelRefundDraft(_prev: State | undefined, formData: FormData): Promise<State> {
  const refundId = String(formData.get("refundId") ?? "").trim();
  const g = await guardEditableDraft(refundId);
  if (!g.ok) return { ok: false, error: refundDocError(g.code) };
  const { ctx, refund } = g;
  const res = await prisma.refund.updateMany({ where: { id: refundId, status: "draft" }, data: { status: "canceled" } });
  if (res.count === 0) return { ok: false, error: refundDocError("NOT_EDITABLE") };
  await recordAudit({ action: "refund.draft_cancelled", entityType: "Refund", entityId: refundId, companyId: refund.companyId, clubId: refund.clubId, userId: ctx.user.id, metadata: { returnType: refund.returnType } });
  revalidatePath("/refunds");
  return { ok: true, refundId };
}

/** "Далее": require the full 4-slot set + complete requisites; then advance
 * (Phase 1 has no submit/routing/calculation — the details step is a stub). */
export async function proceedRefundDraft(_prev: State | undefined, formData: FormData): Promise<State> {
  const refundId = String(formData.get("refundId") ?? "").trim();
  const g = await guardEditableDraft(refundId);
  if (!g.ok) return { ok: false, error: refundDocError(g.code) };
  const { refund } = g;
  if (!refund.returnType) return { ok: false, error: "Выберите тип возврата." };

  const active = await getActiveRefundDocuments(refundId);
  if (!isRefundDocumentSetComplete(refund.returnType, active.map((d) => d.documentType))) {
    return { ok: false, error: "Загрузите все обязательные документы." };
  }
  const req = validateRefundRequisites(refund);
  if (!req.ok) return { ok: false, error: req.error };
  return { ok: true, refundId };
}
