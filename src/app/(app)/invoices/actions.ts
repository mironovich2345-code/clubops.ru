"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canCreateOperational, canMutateOperationalRecords, STRATEGIC_READONLY_ERROR } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import {
  getCurrentAccessContext,
  canAccessClub,
  recordAudit,
  hasActiveRegionalApproverForClub,
} from "@/lib/access";
import {
  getInvoiceForContext,
  applyInvoiceAction,
  canEditInvoice,
  canAddPaidInvoice,
  invoiceSubmitBlockedReason,
  INVOICE_ACTION_AUDIT,
  INVOICE_EDITABLE_STATUSES,
  INVOICE_RETURN_REASON_MIN,
  type InvoiceAction,
} from "@/lib/invoices";
import { getClubLegalEntities } from "@/lib/legal-entities";
import { monthClosedError } from "@/lib/month-close";
import { BULK_MONTHLY_DISABLED_MESSAGE, auditBlockedFeature } from "@/lib/disabled-features";
import type { Role } from "@/lib/auth";
import {
  analyzeInvoiceDocument,
  type InvoiceExtraction,
} from "@/lib/ai/invoice-analyzer";
import { comparePayer, type PayerMatch } from "@/lib/ai/invoice-party";
import { validateInvoiceFile, persistInvoiceFile } from "@/lib/invoice-storage";
import { getStorage } from "@/lib/storage";
import { isUploadedFile } from "@/lib/uploaded-file";
import {
  UPLOAD_ERROR_MESSAGES,
  logUploadFailure,
  type UploadErrorCode,
} from "@/lib/upload-errors";

type AnalyzeState = {
  ok: boolean;
  errorCode?: UploadErrorCode;
  clubId?: string;
  storageKey?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  extraction?: InvoiceExtraction;
  payerName?: string | null;
  payerCheck?: PayerMatch;
};

type SaveState = { ok: boolean; error?: string; invoiceId?: string };

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
  counterpartyName: string | null;
  counterpartyInn: string | null;
  counterpartyKpp: string | null;
  counterpartyBankName: string | null;
  counterpartyBankBik: string | null;
  counterpartyAccount: string | null;
  counterpartyCorrAccount: string | null;
  amountKopeks: number;
  currency: string;
  expenseCategory: string | null;
  expensePeriod: string | null;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  dueDate: Date | null;
  notes: string | null;
};

const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/** expensePeriod from the form, else derived from invoiceDate's month. */
function resolveExpensePeriod(formData: FormData, invoiceDate: Date | null): string | null {
  const raw = String(formData.get("expensePeriod") ?? "").trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  return invoiceDate ? monthOf(invoiceDate) : null;
}

function parseInvoiceFields(formData: FormData): { data?: ParsedFields; error?: string } {
  const amountRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const amount = amountRaw === "" ? 0 : Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "Сумма должна быть неотрицательным числом" };
  }
  const invoiceDate = parseDate(str(formData, "invoiceDate"));
  return {
    data: {
      counterpartyName: str(formData, "counterpartyName"),
      counterpartyInn: str(formData, "counterpartyInn"),
      counterpartyKpp: str(formData, "counterpartyKpp"),
      counterpartyBankName: str(formData, "counterpartyBankName"),
      counterpartyBankBik: str(formData, "counterpartyBankBik"),
      counterpartyAccount: str(formData, "counterpartyAccount"),
      counterpartyCorrAccount: str(formData, "counterpartyCorrAccount"),
      amountKopeks: rublesToKopeks(amount),
      currency: str(formData, "currency") ?? "RUB",
      expenseCategory: str(formData, "expenseCategory"),
      expensePeriod: resolveExpensePeriod(formData, invoiceDate),
      invoiceNumber: str(formData, "invoiceNumber"),
      invoiceDate,
      dueDate: parseDate(str(formData, "dueDate")),
      notes: str(formData, "notes"),
    },
  };
}

async function clubInCompany(clubId: string): Promise<string | null> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  return club?.companyId ?? null;
}

export async function uploadAndAnalyzeInvoice(
  _prev: AnalyzeState | undefined,
  formData: FormData,
): Promise<AnalyzeState> {
  let ctx: Awaited<ReturnType<typeof getCurrentAccessContext>> = null;
  const clubId = String(formData.get("clubId") ?? "").trim();
  const fileEntry = formData.get("file");
  const file = isUploadedFile(fileEntry) ? fileEntry : null;
  const fileInfo = {
    fileName: file?.name ?? null,
    fileMime: file?.type ?? null,
    fileSize: file?.size ?? null,
  };

  // Records a sanitized log line and returns the state, preserving clubId so the
  // UI keeps the selection.
  function fail(code: UploadErrorCode, message = ""): AnalyzeState {
    logUploadFailure("invoice", {
      code,
      message,
      userId: ctx?.user.id ?? null,
      companyId: ctx?.selectedCompanyId ?? null,
      clubId: clubId || null,
      ...fileInfo,
    });
    return { ok: false, errorCode: code, clubId: clubId || undefined };
  }

  try {
    ctx = await getCurrentAccessContext();
    if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) return fail("ACCESS_DENIED");
    if (!canCreateOperational(ctx.effectiveRoles)) return fail("ACCESS_DENIED");

    if (!clubId) return fail("CLUB_REQUIRED");
    if (!ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
      return fail("ACCESS_DENIED");
    }

    if (!file) return fail("FILE_INVALID");
    const fileCode = validateInvoiceFile(file);
    if (fileCode) return fail(fileCode);

    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch (readError) {
      return fail("FILE_READ_FAILED", readError instanceof Error ? readError.message : "read failed");
    }

    // Best-effort persist: recognition must still work from the in-memory buffer.
    let storageKey: string | undefined;
    let size = file.size;
    let storageFailed = false;
    try {
      const stored = await persistInvoiceFile(buffer, file.type, file.name);
      storageKey = stored.storageKey;
      size = stored.size;
    } catch (storeError) {
      storageFailed = true;
      logUploadFailure("invoice", {
        code: "STORAGE_FAILED",
        message: storeError instanceof Error ? storeError.message : "store failed",
        userId: ctx.user.id,
        companyId: ctx.selectedCompanyId,
        clubId,
        ...fileInfo,
      });
    }

    const extraction = await analyzeInvoiceDocument({ buffer, mime: file.type, fileName: file.name });
    if (storageFailed) {
      extraction.warnings = [UPLOAD_ERROR_MESSAGES.STORAGE_FAILED, ...extraction.warnings];
    }

    // Payer-vs-selected-company check (warning only — never blocks the save).
    let payerCheck: PayerMatch = "unknown";
    try {
      const company = await prisma.company.findUnique({
        where: { id: ctx.selectedCompanyId ?? "" },
        select: { name: true, inn: true, kpp: true },
      });
      if (company) {
        payerCheck = comparePayer(
          { name: extraction.payerName, inn: extraction.payerInn, kpp: extraction.payerKpp },
          { name: company.name, inn: company.inn, kpp: company.kpp },
        );
      }
    } catch (payerError) {
      console.error("payer check failed", payerError instanceof Error ? payerError.message : payerError);
    }

    try {
      await recordAudit({
        action: "invoice.uploaded",
        entityType: "Invoice",
        companyId: ctx.selectedCompanyId,
        clubId,
        userId: ctx.user.id,
        metadata: { fileName: file.name, mime: file.type, size },
      });
      await recordAudit({
        action: "invoice.extracted",
        entityType: "Invoice",
        companyId: ctx.selectedCompanyId,
        clubId,
        userId: ctx.user.id,
        // Safe diagnostics only — never document content / text / base64.
        metadata: {
          confidence: extraction.confidence, mode: extraction.mode, sourceMode: extraction.sourceMode,
          errorCode: extraction.errorCode, technicalQuality: extraction.technicalQuality,
          modelUsed: extraction.modelUsed, fallbackUsed: extraction.fallbackUsed,
          pageCount: extraction.diagnostics?.pageCount ?? null, textLength: extraction.diagnostics?.textLength ?? null,
        },
      });
    } catch (auditError) {
      console.error("invoice audit failed", auditError instanceof Error ? auditError.message : auditError);
    }

    return {
      ok: true,
      clubId,
      storageKey,
      fileName: file.name,
      fileMime: file.type,
      fileSize: size,
      extraction,
      payerName: extraction.payerName,
      payerCheck,
    };
  } catch (error) {
    return fail("UNKNOWN_ERROR", error instanceof Error ? error.message : "unknown");
  }
}

/**
 * Draftless create: validate → create the invoice ALREADY in `needs_review` →
 * audit, in one operation. There is no draft and no separate "send for review"
 * step. Expected business errors are RETURNED (never thrown) so the page never
 * falls into the error boundary. Idempotent: a per-form clientSubmissionId makes
 * a double-click / retried POST return the same invoice instead of a duplicate.
 */
export async function createAndSubmitInvoice(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return { ok: false, error: "Создавать счета могут управляющие и региональные директора" };
  }

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }
  const companyId = await clubInCompany(clubId);
  if (!companyId || companyId !== ctx.selectedCompanyId) {
    return { ok: false, error: "Клуб не найден" };
  }

  const parsed = parseInvoiceFields(formData);
  if (parsed.error || !parsed.data) return { ok: false, error: parsed.error ?? "Ошибка данных" };

  // Same minimum-data gate the submit-for-review used, applied up-front so an
  // incomplete invoice is never created. AI confidence is NOT a gate.
  const storageKey = str(formData, "storageKey");
  const blocked = invoiceSubmitBlockedReason({
    counterpartyName: parsed.data.counterpartyName,
    amountKopeks: parsed.data.amountKopeks,
    hasFile: Boolean(storageKey),
  });
  if (blocked) return { ok: false, error: blocked };

  const closed = await monthClosedError(companyId, clubId, parsed.data.invoiceDate ?? new Date());
  if (closed) return { ok: false, error: closed };

  // Legal entity: only honour one that is attached to this club.
  let legalEntityId: string | null = null;
  const requestedEntityId = str(formData, "legalEntityId");
  if (requestedEntityId) {
    const attached = await getClubLegalEntities(clubId);
    legalEntityId = attached.some((e) => e.id === requestedEntityId) ? requestedEntityId : null;
  }

  const confidenceRaw = String(formData.get("confidence") ?? "low");
  const confidence = ["low", "medium", "high"].includes(confidenceRaw) ? confidenceRaw : "low";

  // Idempotency: a repeated submit with the same key returns the existing invoice
  // (author-scoped) instead of creating a second one.
  const clientSubmissionId = str(formData, "clientSubmissionId");
  if (clientSubmissionId) {
    const dup = await prisma.invoice.findUnique({
      where: { clientSubmissionId },
      select: { id: true, createdByUserId: true },
    });
    if (dup && dup.createdByUserId === ctx.user.id) return { ok: true, invoiceId: dup.id };
  }

  let invoice;
  try {
    invoice = await prisma.invoice.create({
      data: {
        companyId,
        clubId,
        createdByUserId: ctx.user.id,
        ...parsed.data,
        legalEntityId,
        // Draftless: created directly in the regional review queue.
        status: "needs_review",
        confidence,
        clientSubmissionId: clientSubmissionId || null,
        payerName: str(formData, "payerName"),
        payerInn: str(formData, "payerInn"),
        payerKpp: str(formData, "payerKpp"),
        originalFileName: str(formData, "fileName"),
        originalFileMime: str(formData, "fileMime"),
        originalFileSize: Number(formData.get("fileSize")) || null,
        originalFileStorageKey: storageKey,
        rawExtractedJson: str(formData, "rawExtractedJson"),
      },
    });
  } catch (error) {
    // Concurrent double-submit that raced past the pre-check: the unique key
    // rejects the second create — return the row the winner made.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && clientSubmissionId) {
      const dup = await prisma.invoice.findUnique({ where: { clientSubmissionId }, select: { id: true } });
      if (dup) return { ok: true, invoiceId: dup.id };
    }
    console.error("createAndSubmitInvoice failed", error instanceof Error ? error.message : error);
    return { ok: false, error: "Не удалось сохранить счёт. Повторите попытку." };
  }

  await recordAudit({
    action: "invoice.created",
    entityType: "Invoice",
    entityId: invoice.id,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { confidence, amountKopeks: invoice.amountKopeks, status: "needs_review" },
  });
  await recordAudit({
    action: "invoice.sent_for_review",
    entityType: "Invoice",
    entityId: invoice.id,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { amountKopeks: invoice.amountKopeks },
  });

  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  return { ok: true, invoiceId: invoice.id };
}

/**
 * Quick entry of a historical, already-paid invoice (for importing past months).
 * Status becomes `paid` immediately with no approval workflow, so it counts in
 * expenses / budget / analytics right away. Manager/regional only, scoped.
 */
export async function saveHistoricalInvoice(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return { ok: false, error: "Нет доступа" };
  }
  // «Добавить оплаченный счёт» — ONLY accountant / chief accountant. Manager /
  // regional / owner / general_director / system_admin are refused server-side
  // (UI hiding is not enough).
  if (!canAddPaidInvoice(ctx.effectiveRoles)) {
    return { ok: false, error: "Добавить оплаченный счёт может только бухгалтер или главный бухгалтер" };
  }

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }
  const companyId = await clubInCompany(clubId);
  if (!companyId || companyId !== ctx.selectedCompanyId) {
    return { ok: false, error: "Клуб не найден" };
  }

  const amountRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const amount = amountRaw === "" ? 0 : Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Укажите положительную сумму" };
  }
  const invoiceDate = parseDate(str(formData, "invoiceDate"));
  if (!invoiceDate) return { ok: false, error: "Укажите дату счёта" };
  const paidAt = parseDate(str(formData, "paidDate"));
  if (!paidAt) return { ok: false, error: "Укажите дату оплаты" };

  // The reporting month of a paid invoice is its paidAt month — block both the
  // invoice-date month and the paidAt month if either is closed.
  const closedHist = await monthClosedError(companyId, clubId, invoiceDate);
  if (closedHist) return { ok: false, error: closedHist };
  const closedPaid = await monthClosedError(companyId, clubId, paidAt);
  if (closedPaid) return { ok: false, error: closedPaid };

  let legalEntityId: string | null = null;
  const requestedEntityId = str(formData, "legalEntityId");
  if (requestedEntityId) {
    const attached = await getClubLegalEntities(clubId);
    legalEntityId = attached.some((e) => e.id === requestedEntityId) ? requestedEntityId : null;
  }

  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      clubId,
      createdByUserId: ctx.user.id,
      legalEntityId,
      counterpartyName: str(formData, "counterpartyName"),
      amountKopeks: rublesToKopeks(amount),
      currency: "RUB",
      expenseCategory: str(formData, "expenseCategory"),
      // Expense belongs to its period; money may leave in a different month.
      expensePeriod: resolveExpensePeriod(formData, invoiceDate),
      invoiceNumber: str(formData, "invoiceNumber"),
      invoiceDate,
      paidAt,
      // Historical entry: paid immediately, no approval workflow.
      status: "paid",
      confidence: "high",
      comment: str(formData, "comment"),
    },
  });

  await recordAudit({
    action: "invoice.created",
    entityType: "Invoice",
    entityId: invoice.id,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { historical: true, status: "paid", amountKopeks: invoice.amountKopeks },
  });
  await recordAudit({
    action: "invoice.paid",
    entityType: "Invoice",
    entityId: invoice.id,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: {
      historical: true, paidAt: paidAt.toISOString(), amountKopeks: invoice.amountKopeks,
      role: ctx.effectiveRoles.includes("chief_accountant") ? "chief_accountant" : "accountant",
    },
  });

  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  revalidatePath("/budgets");
  revalidatePath("/analytics");
  return { ok: true, invoiceId: invoice.id };
}

export async function updateInvoice(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return { ok: false, error: "Нет доступа" };
  }
  // Strategic roles (owner / GD) view invoices but never edit them.
  if (!canMutateOperationalRecords(ctx.effectiveRoles)) {
    return { ok: false, error: STRATEGIC_READONLY_ERROR };
  }

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  const existing = await getInvoiceForContext(ctx, invoiceId);
  if (!existing) return { ok: false, error: "Счёт не найден или нет доступа" };

  // Field edits are allowed ONLY in draft / needs_correction (by the author) or on
  // a paid invoice (by the accountant). needs_review, approved_*, rejected and
  // canceled are immutable — a reviewer returns the invoice for correction rather
  // than editing it. Enforced server-side (the button is also hidden in the UI).
  if (!canEditInvoice(existing.status, ctx.effectiveRoles)) {
    return {
      ok: false,
      error: existing.status === "paid"
        ? "Оплаченный счёт может редактировать только бухгалтер"
        : "Счёт можно редактировать только в статусе «Черновик» или «Возвращён на исправление»",
    };
  }
  // In the editable unpaid statuses only the AUTHOR may edit — the regional
  // director reviews but never edits the manager's fields. (A paid invoice is
  // edited by the accountant — handled by canEditInvoice above.)
  if (existing.status !== "paid" && existing.createdByUserId !== ctx.user.id) {
    return { ok: false, error: "Редактировать поля счёта может только его автор" };
  }
  const closedEdit = await monthClosedError(existing.companyId, existing.clubId, existing.invoiceDate ?? existing.createdAt);
  if (closedEdit) return { ok: false, error: closedEdit };

  const parsed = parseInvoiceFields(formData);
  if (parsed.error || !parsed.data) return { ok: false, error: parsed.error ?? "Ошибка данных" };

  await prisma.invoice.update({ where: { id: invoiceId }, data: parsed.data });

  await recordAudit({
    action: "invoice.updated",
    entityType: "Invoice",
    entityId: invoiceId,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
  });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
  return { ok: true, invoiceId };
}

// --- secure file replacement (draft / needs_correction only) ----------------

type ReplaceFileState = { ok: boolean; error?: string; invoiceId?: string };

/**
 * Replaces the invoice's stored document. Only the AUTHOR, and only while the
 * invoice is a draft or was returned for correction, may swap the file. Server
 * enforces role → author → scope → status → file validation (magic bytes); the
 * client MIME / extension / storage key are never trusted (a fresh key is minted
 * server-side). Storage-safe ordering: upload NEW → compare-and-set DB → on DB
 * miss delete the new object (old file stays authoritative) → on success delete
 * the OLD object best-effort. No storage keys / PII in the error or audit.
 */
export async function replaceInvoiceFile(
  _prev: ReplaceFileState | undefined,
  formData: FormData,
): Promise<ReplaceFileState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return { ok: false, error: "Нет доступа" };
  }
  // Strategic roles (owner / GD) view invoices but never mutate them.
  if (!canMutateOperationalRecords(ctx.effectiveRoles)) {
    return { ok: false, error: STRATEGIC_READONLY_ERROR };
  }

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  // Scoped loader: enforces selectedCompanyId + allowedClubIds (and manager-own).
  const existing = await getInvoiceForContext(ctx, invoiceId);
  if (!existing) return { ok: false, error: "Счёт не найден или нет доступа" };

  // Only the AUTHOR replaces the file — a regional director / other manager
  // reviews but never swaps the author's document.
  if (existing.createdByUserId !== ctx.user.id) {
    return { ok: false, error: "Заменить файл может только автор счёта" };
  }
  // And only while the invoice is still being prepared or was returned to fix.
  if (!(INVOICE_EDITABLE_STATUSES as readonly string[]).includes(existing.status)) {
    return { ok: false, error: "Заменить файл можно только в статусе «Черновик» или «Возвращён на исправление»" };
  }

  const closed = await monthClosedError(existing.companyId, existing.clubId, existing.invoiceDate ?? existing.createdAt);
  if (closed) return { ok: false, error: closed };

  const fileEntry = formData.get("file");
  const file = isUploadedFile(fileEntry) ? fileEntry : null;
  if (!file) return { ok: false, error: "Прикрепите файл счёта." };
  // Allowlist (PDF/JPEG/PNG/WEBP) + size — declared MIME only gets past here if it
  // is on the allowlist; the magic-byte check below is the real gate.
  const validationCode = validateInvoiceFile(file);
  if (validationCode) return { ok: false, error: UPLOAD_ERROR_MESSAGES[validationCode] };

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return { ok: false, error: UPLOAD_ERROR_MESSAGES.FILE_READ_FAILED };
  }

  // 1. Persist the NEW file first. persistInvoiceFile sniffs magic bytes (rejects
  //    HTML/SVG/script disguised behind an image MIME) and mints a fresh random
  //    server-side storage key — the client never supplies the key or extension.
  let stored: Awaited<ReturnType<typeof persistInvoiceFile>>;
  try {
    stored = await persistInvoiceFile(buffer, file.type, file.name);
  } catch {
    return { ok: false, error: "Файл не распознан как PDF/JPEG/PNG/WEBP или повреждён." };
  }

  const oldStorageKey = existing.originalFileStorageKey;

  // 2. Compare-and-set: swap the file only if the invoice is STILL this author's
  //    and STILL in the same status/scope (no concurrent transition slipped in).
  const updated = await prisma.invoice.updateMany({
    where: {
      id: invoiceId, status: existing.status, createdByUserId: ctx.user.id,
      companyId: existing.companyId, clubId: existing.clubId,
    },
    data: {
      originalFileStorageKey: stored.storageKey,
      originalFileName: stored.fileName,
      originalFileMime: stored.mime,
      originalFileSize: stored.size,
    },
  });

  // 3. DB update didn't happen (status/owner changed) → roll back the just-uploaded
  //    object; the OLD file stays authoritative. Never surface the storage key.
  if (updated.count === 0) {
    try { await getStorage().delete(stored.storageKey); } catch { /* best-effort rollback */ }
    return { ok: false, error: "Статус счёта изменился. Обновите страницу." };
  }

  // 4. Success → best-effort delete of the OLD object. A cleanup failure must NOT
  //    undo the replacement (the DB already points at the new file — an orphaned
  //    old object is tolerated over losing the successful swap).
  if (oldStorageKey && oldStorageKey !== stored.storageKey) {
    try { await getStorage().delete(oldStorageKey); } catch { /* orphan tolerated */ }
  }

  // Audit: ids + status transition + timestamp only. Never storage keys, document
  // content, recognized text, bank requisites or other PII (recordAudit stamps ts).
  await recordAudit({
    action: "invoice.file_replaced",
    entityType: "Invoice",
    entityId: invoiceId,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
    metadata: { fromStatus: existing.status, toStatus: existing.status },
  });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
  return { ok: true, invoiceId };
}

// --- cancellation (soft) ----------------------------------------------------

// Cancel: manager / regional / accountant (chief accountant inherits accountant).
// Owner and general director are strategic (read-only) and cannot cancel.
function canCancelInvoiceRole(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "manager" || r === "regional_director" || r === "accountant");
}
// A plain manager (no higher role) may not cancel a PAID invoice.
function isManagerOnly(roles: readonly Role[]): boolean {
  return roles.includes("manager") && !roles.some((r) => r === "regional_director" || r === "general_director" || r === "owner" || r === "accountant");
}

const INVOICE_CANCELABLE = ["draft", "needs_review", "approved_by_regional", "approved_by_owner", "paid"];

type CancelState = { ok: boolean; error?: string };

function revalidateInvoiceFinancial() {
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  revalidatePath("/budgets");
  revalidatePath("/analytics");
}

/** Soft-cancel a single invoice (status -> canceled). Scoped to company +
 * allowed clubs; managers may only cancel unpaid invoices in their own club. */
export async function cancelInvoice(
  _prev: CancelState | undefined,
  formData: FormData,
): Promise<CancelState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) return { ok: false, error: "Нет доступа" };
  if (!canCancelInvoiceRole(ctx.effectiveRoles)) return { ok: false, error: "Недостаточно прав для отмены счёта" };

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const existing = await getInvoiceForContext(ctx, invoiceId);
  if (!existing) return { ok: false, error: "Счёт не найден или нет доступа" };

  if (!INVOICE_CANCELABLE.includes(existing.status)) {
    return { ok: false, error: "Этот счёт нельзя отменить" };
  }
  if (isManagerOnly(ctx.effectiveRoles) && existing.status === "paid") {
    return { ok: false, error: "Управляющий не может отменить оплаченный счёт" };
  }
  const closed = await monthClosedError(existing.companyId, existing.clubId, existing.invoiceDate ?? existing.createdAt);
  if (closed) return { ok: false, error: closed };

  await prisma.invoice.update({ where: { id: existing.id }, data: { status: "canceled" } });
  await recordAudit({
    action: "invoice.canceled",
    entityType: "Invoice",
    entityId: existing.id,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
    metadata: { prevStatus: existing.status, amountKopeks: existing.amountKopeks, reason },
  });

  revalidateInvoiceFinancial();
  revalidatePath(`/invoices/${existing.id}`);
  return { ok: true };
}

// --- monthly bulk cancel: DISABLED (pre-pilot product decision) -------------
// Monthly bulk cancellation has been removed. These exported actions remain only
// to reject any direct invocation with a safe denial and a sanitized audit
// event. Cancel a single invoice with `cancelInvoice` above; month close/reopen
// is unaffected. Historical canceled rows are never touched here.
type BulkState = { ok: boolean; error?: string; count?: number; totalKopeks?: number; done?: boolean };

export async function previewBulkCancelInvoices(): Promise<BulkState> {
  await auditBlockedFeature("invoice.bulk_cancel_preview");
  return { ok: false, error: BULK_MONTHLY_DISABLED_MESSAGE };
}

export async function cancelInvoicesForMonth(): Promise<BulkState> {
  await auditBlockedFeature("invoice.bulk_cancel");
  return { ok: false, error: BULK_MONTHLY_DISABLED_MESSAGE };
}

type TransitionState = { ok: boolean; error?: string; info?: string };

/**
 * Workflow transition (approve / reject / return / pay / send). Returns a state
 * object for EVERY outcome — expected business errors (stale status, blocked
 * submit, month closed, self-approval, missing reason) are RETURNED, never
 * thrown, so a bound form never triggers the app error boundary. Only a truly
 * unexpected fault propagates.
 */
export async function transitionInvoice(
  _prev: TransitionState | undefined,
  formData: FormData,
): Promise<TransitionState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return { ok: false, error: "Нет доступа" };
  }

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  const action = String(formData.get("action") ?? "").trim() as InvoiceAction;
  if (!(action in INVOICE_ACTION_AUDIT)) return { ok: false, error: "Неверное действие" };

  const existing = await getInvoiceForContext(ctx, invoiceId);
  if (!existing) return { ok: false, error: "Счёт не найден или нет доступа" };

  const closedTx = await monthClosedError(existing.companyId, existing.clubId, existing.invoiceDate ?? existing.createdAt);
  if (closedTx) return { ok: false, error: closedTx };

  // Sending for review requires the minimum data (counterparty, amount, file).
  // AI confidence is NOT a gate — a hand-filled invoice may always be sent.
  if (action === "send_to_review") {
    const blocked = invoiceSubmitBlockedReason({
      counterpartyName: existing.counterpartyName,
      amountKopeks: existing.amountKopeks,
      hasFile: Boolean(existing.originalFileStorageKey),
    });
    if (blocked) return { ok: false, error: blocked };
  }

  // Returning for correction requires a reason (shown to the author). Same
  // minimum length as refunds. The reason is NOT a document/bank detail.
  const returnReason = String(formData.get("reason") ?? "").trim();
  if (action === "return_for_correction" && returnReason.length < INVOICE_RETURN_REASON_MIN) {
    return { ok: false, error: `Укажите причину возврата (не менее ${INVOICE_RETURN_REASON_MIN} символов).` };
  }

  // Resolve approver routing from live access (regional vs chief fallback) + the
  // self-approval rule, then apply the pure decision table.
  const hasActiveRegional = await hasActiveRegionalApproverForClub(existing.companyId, existing.clubId);
  const isCreator = existing.createdByUserId === ctx.user.id;
  const result = applyInvoiceAction(action, existing.status, ctx.effectiveRoles, { hasActiveRegional, isCreator });
  if (!result.ok) {
    if (action === "approve" || action === "reject" || action === "return_for_correction") {
      await recordAudit({
        action: "invoice.approval_blocked",
        entityType: "Invoice",
        entityId: invoiceId,
        companyId: existing.companyId,
        clubId: existing.clubId,
        userId: ctx.user.id,
        metadata: { from: existing.status, action, fallbackAvailable: !hasActiveRegional, reason: result.error },
      });
    }
    return { ok: false, error: result.error };
  }

  // Conditional (compare-and-set) update on the exact current status: only one
  // concurrent request can flip the status. A stale/duplicate submit updates 0
  // rows and gets a clear "already changed" message — never a raw Prisma error.
  const data: {
    status: string; paidAt: Date | null;
    correctionComment?: string; correctionRequestedAt?: Date; correctionRequestedByUserId?: string;
  } = { status: result.to, paidAt: result.to === "paid" ? new Date() : null };
  if (action === "return_for_correction") {
    data.correctionComment = returnReason;
    data.correctionRequestedAt = new Date();
    data.correctionRequestedByUserId = ctx.user.id;
  }
  const updated = await prisma.invoice.updateMany({
    where: { id: invoiceId, status: existing.status },
    data,
  });
  if (updated.count === 0) {
    return { ok: false, error: "Статус счёта уже изменён. Обновите страницу." };
  }

  const approverRole = hasActiveRegional ? "regional_director" : "chief_accountant";
  const auditAction =
    action === "approve"
      ? result.to === "approved_by_chief_accountant"
        ? "invoice.approved_by_chief_accountant"
        : "invoice.approved_by_regional"
      : action === "reject"
        ? hasActiveRegional
          ? "invoice.rejected_by_regional"
          : "invoice.rejected_by_chief_accountant"
        : INVOICE_ACTION_AUDIT[action];

  await recordAudit({
    action: auditAction,
    entityType: "Invoice",
    entityId: invoiceId,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
    metadata: {
      from: existing.status,
      to: result.to,
      action,
      ...(action === "approve" || action === "reject" ? { approverRole, fallbackUsed: !hasActiveRegional } : {}),
      ...(action === "return_for_correction" ? { reason: returnReason } : {}),
    },
  });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

// --- Correction resubmit (needs_correction -> needs_review) -----------------

/**
 * One-button "Сохранить и повторно отправить" for a returned invoice. Saves the
 * author's field edits, optionally replaces the file, and flips
 * needs_correction → needs_review in a single compare-and-set — no separate
 * "send" step. Safe file ordering (upload NEW → CAS → roll back NEW on miss →
 * delete OLD on success). Never re-runs AI. Returns state for every outcome.
 */
export async function saveAndResubmitInvoice(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canMutateOperationalRecords(ctx.effectiveRoles)) {
    return { ok: false, error: STRATEGIC_READONLY_ERROR };
  }

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  const existing = await getInvoiceForContext(ctx, invoiceId);
  if (!existing) return { ok: false, error: "Счёт не найден или нет доступа" };

  if (existing.status !== "needs_correction") {
    return { ok: false, error: "Действие доступно только для счёта, возвращённого на исправление." };
  }
  // Only the AUTHOR corrects and resubmits their own invoice.
  if (existing.createdByUserId !== ctx.user.id) {
    return { ok: false, error: "Исправить и отправить счёт может только его автор." };
  }
  const closed = await monthClosedError(existing.companyId, existing.clubId, existing.invoiceDate ?? existing.createdAt);
  if (closed) return { ok: false, error: closed };

  const parsed = parseInvoiceFields(formData);
  if (parsed.error || !parsed.data) return { ok: false, error: parsed.error ?? "Ошибка данных" };

  // Optional file replacement — persist the NEW object first (magic-byte checked,
  // fresh server-side key). Never trust the client MIME / key.
  const fileEntry = formData.get("file");
  const file = isUploadedFile(fileEntry) ? fileEntry : null;
  let newStored: Awaited<ReturnType<typeof persistInvoiceFile>> | null = null;
  if (file && file.size > 0) {
    const validationCode = validateInvoiceFile(file);
    if (validationCode) return { ok: false, error: UPLOAD_ERROR_MESSAGES[validationCode] };
    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch {
      return { ok: false, error: UPLOAD_ERROR_MESSAGES.FILE_READ_FAILED };
    }
    try {
      newStored = await persistInvoiceFile(buffer, file.type, file.name);
    } catch {
      return { ok: false, error: "Файл не распознан как PDF/JPEG/PNG/WEBP или повреждён." };
    }
  }

  // Required-data gate on the SUBMITTED values (new file counts if attached).
  const hasFile = Boolean(newStored?.storageKey ?? existing.originalFileStorageKey);
  const blocked = invoiceSubmitBlockedReason({
    counterpartyName: parsed.data.counterpartyName,
    amountKopeks: parsed.data.amountKopeks,
    hasFile,
  });
  if (blocked) {
    if (newStored) { try { await getStorage().delete(newStored.storageKey); } catch { /* best-effort */ } }
    return { ok: false, error: blocked };
  }

  // Single compare-and-set: fields + (optional) file metadata + status flip, only
  // while STILL this author's needs_correction invoice. No partial state.
  const data: Record<string, unknown> = { ...parsed.data, status: "needs_review" };
  if (newStored) {
    data.originalFileStorageKey = newStored.storageKey;
    data.originalFileName = newStored.fileName;
    data.originalFileMime = newStored.mime;
    data.originalFileSize = newStored.size;
  }
  const updated = await prisma.invoice.updateMany({
    where: {
      id: invoiceId, status: "needs_correction", createdByUserId: ctx.user.id,
      companyId: existing.companyId, clubId: existing.clubId,
    },
    data,
  });
  if (updated.count === 0) {
    if (newStored) { try { await getStorage().delete(newStored.storageKey); } catch { /* best-effort */ } }
    return { ok: false, error: "Статус счёта изменился. Обновите страницу." };
  }

  // Success → best-effort delete of the replaced OLD object (orphan tolerated).
  if (newStored && existing.originalFileStorageKey && existing.originalFileStorageKey !== newStored.storageKey) {
    try { await getStorage().delete(existing.originalFileStorageKey); } catch { /* orphan tolerated */ }
  }

  await recordAudit({
    action: "invoice.updated",
    entityType: "Invoice",
    entityId: invoiceId,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
    metadata: { fileReplaced: Boolean(newStored) },
  });
  await recordAudit({
    action: "invoice.resubmitted",
    entityType: "Invoice",
    entityId: invoiceId,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
    metadata: { from: "needs_correction", to: "needs_review" },
  });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/dashboard");
  return { ok: true, invoiceId };
}
