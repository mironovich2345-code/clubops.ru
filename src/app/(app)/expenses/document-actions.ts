"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { getExpenseForContext } from "@/lib/expenses";
import { monthClosedError } from "@/lib/month-close";
import { isUploadedFile } from "@/lib/uploaded-file";
import { isExpenseDocumentsEditable, DOCUMENT_TYPES } from "@/lib/expense-attachments";
import { newRequestId } from "@/lib/upload-errors";
import { type DocErrorCode, docErrorMessage } from "@/lib/expense-document-errors";
import {
  MAX_DOCUMENTS_PER_EXPENSE, MAX_AGGREGATE_SIZE,
  validateDeclaredDocument, validateSignature, storeExpenseDocument, safeFilename, sha256Hex,
} from "@/lib/expense-document-storage";

type UploadState = { ok: boolean; uploaded?: number; errors?: string[]; error?: string };

type ExpenseCtx = NonNullable<Awaited<ReturnType<typeof getExpenseForContext>>>;
type AccessCtx = NonNullable<Awaited<ReturnType<typeof getCurrentAccessContext>>>;
type Guard =
  | { ok: true; expense: ExpenseCtx; ctx: AccessCtx }
  | { ok: false; code: DocErrorCode; expense?: ExpenseCtx; ctx?: AccessCtx };

// Common guard: authenticated + object-scoped + role + editable + month open.
async function guardEditable(expenseId: string): Promise<Guard> {
  const ctx = await getCurrentAccessContext();
  if (!ctx) return { ok: false, code: "ACCESS_DENIED" };
  const expense = await getExpenseForContext(ctx, expenseId); // object-level company+club authz
  if (!expense) return { ok: false, code: "ACCESS_DENIED" };
  // Manager/regional create-capable roles only (owner/GD/accountant may not
  // silently mutate manager attachments). Fail-closed for unknown roles.
  if (!canCreateOperational(ctx.effectiveRoles)) return { ok: false, code: "ACCESS_DENIED", expense, ctx };
  if (!isExpenseDocumentsEditable(expense)) return { ok: false, code: "NOT_EDITABLE", expense, ctx };
  const closed = await monthClosedError(expense.companyId, expense.clubId, expense.expenseDate);
  if (closed) return { ok: false, code: "MONTH_CLOSED", expense, ctx };
  return { ok: true, expense, ctx };
}

/**
 * Upload one or more documents to an editable simplified expense. Each file is
 * validated independently (declared MIME + signature + size + dedup); a failure
 * on one file never discards the others. Uploading does NOT submit the expense.
 */
export async function uploadExpenseDocuments(_prev: UploadState | undefined, formData: FormData): Promise<UploadState> {
  const expenseId = String(formData.get("expenseId") ?? "").trim();
  const guard = await guardEditable(expenseId);
  if (!guard.ok) {
    if (guard.expense && guard.ctx) {
      await recordAudit({ action: "expense.document_access_denied", entityType: "Expense", entityId: expenseId, companyId: guard.expense.companyId, clubId: guard.expense.clubId, userId: guard.ctx.user.id, metadata: { reason: guard.code, op: "upload" } });
    }
    return { ok: false, error: docErrorMessage(guard.code) };
  }
  const { expense, ctx } = guard;

  const rawType = String(formData.get("documentType") ?? "receipt");
  const documentType = (DOCUMENT_TYPES as readonly string[]).includes(rawType) ? rawType : "receipt";
  const files = (formData.getAll("documents") as unknown[]).filter(isUploadedFile);
  if (files.length === 0) return { ok: false, error: "Выберите файл." };

  // Existing active documents (count, aggregate size, sha set for dedup).
  const active = await prisma.expenseDocument.findMany({ where: { expenseId, removedAt: null }, select: { sizeBytes: true, sha256: true } });
  let count = active.length;
  let aggregate = active.reduce((s, d) => s + d.sizeBytes, 0);
  const seenSha = new Set(active.map((d) => d.sha256));

  const errors: string[] = [];
  let uploaded = 0;

  for (const file of files) {
    const fail = (code: DocErrorCode, mime: string | null, size: number | null) => {
      errors.push(`${safeFilename(file.name)}: ${docErrorMessage(code)}`);
      const requestId = newRequestId();
      // Sanitized audit — no file bytes/text, only safe metadata.
      void recordAudit({ action: "expense.document_upload_failed", entityType: "Expense", entityId: expenseId, companyId: expense.companyId, clubId: expense.clubId, userId: ctx.user.id, metadata: { reason: code, requestId, mimeCategory: (mime ?? "").split("/")[0] || null, sizeBytes: size } });
    };

    const declared = validateDeclaredDocument(file);
    if (!declared.ok) { fail(declared.code as DocErrorCode, file.type, file.size); continue; }
    if (count + 1 > MAX_DOCUMENTS_PER_EXPENSE) { errors.push(docErrorMessage("TOO_MANY")); break; }

    let buffer: Buffer;
    try { buffer = Buffer.from(await file.arrayBuffer()); } catch { fail("FILE_INVALID", file.type, file.size); continue; }
    const sig = validateSignature(buffer, file.type);
    if (!sig.ok) { fail(sig.code as DocErrorCode, file.type, file.size); continue; }
    if (aggregate + buffer.length > MAX_AGGREGATE_SIZE) { errors.push(docErrorMessage("AGGREGATE_EXCEEDED")); break; }

    const sha = sha256Hex(buffer);
    if (seenSha.has(sha)) { fail("DUPLICATE", file.type, file.size); continue; }

    let stored;
    try { stored = await storeExpenseDocument(buffer, file.type); } catch { fail("STORAGE_FAILED", file.type, file.size); continue; }

    const doc = await prisma.expenseDocument.create({
      data: {
        expenseId, companyId: expense.companyId, clubId: expense.clubId,
        storageKey: stored.storageKey, originalFilename: file.name.slice(0, 255), safeFilename: safeFilename(file.name),
        mimeType: file.type, sizeBytes: stored.sizeBytes, sha256: sha, documentType, uploadedByUserId: ctx.user.id,
      },
    });
    await recordAudit({ action: "expense.document_uploaded", entityType: "ExpenseDocument", entityId: doc.id, companyId: expense.companyId, clubId: expense.clubId, userId: ctx.user.id, metadata: { expenseId, documentType, mimeCategory: file.type.split("/")[0], sizeBytes: stored.sizeBytes } });
    seenSha.add(sha); count += 1; aggregate += buffer.length; uploaded += 1;
  }

  revalidatePath(`/expenses/${expenseId}`);
  return { ok: uploaded > 0, uploaded, errors: errors.length ? errors : undefined, error: uploaded === 0 ? errors[0] ?? docErrorMessage("UNKNOWN") : undefined };
}

type RemoveState = { ok: boolean; error?: string };

/** Soft-remove an active document (reason required). Idempotent; audited. */
export async function removeExpenseDocument(_prev: RemoveState | undefined, formData: FormData): Promise<RemoveState> {
  const expenseId = String(formData.get("expenseId") ?? "").trim();
  const documentId = String(formData.get("documentId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  const guard = await guardEditable(expenseId);
  if (!guard.ok) return { ok: false, error: docErrorMessage(guard.code) };
  const { expense, ctx } = guard;
  if (!reason) return { ok: false, error: docErrorMessage("REASON_REQUIRED") };

  const doc = await prisma.expenseDocument.findUnique({ where: { id: documentId }, select: { expenseId: true, removedAt: true } });
  if (!doc || doc.expenseId !== expenseId) return { ok: false, error: docErrorMessage("NOT_FOUND") };
  if (doc.removedAt) return { ok: true }; // idempotent

  // Once submitted (needs_correction), keep at least one active document.
  if (expense.status === "needs_correction") {
    const active = await prisma.expenseDocument.count({ where: { expenseId, removedAt: null } });
    if (active <= 1) return { ok: false, error: docErrorMessage("MIN_DOCUMENTS") };
  }

  const removed = await prisma.expenseDocument.updateMany({ where: { id: documentId, removedAt: null }, data: { removedAt: new Date(), removedByUserId: ctx.user.id, removalReason: reason.slice(0, 300) } });
  if (removed.count === 0) return { ok: true }; // concurrent — idempotent
  await recordAudit({ action: "expense.document_removed", entityType: "ExpenseDocument", entityId: documentId, companyId: expense.companyId, clubId: expense.clubId, userId: ctx.user.id, metadata: { expenseId, reason: reason.slice(0, 120) } });
  revalidatePath(`/expenses/${expenseId}`);
  return { ok: true };
}
