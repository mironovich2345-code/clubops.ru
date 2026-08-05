"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canCreateOperational, canMutateOperationalRecords, STRATEGIC_READONLY_ERROR } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { canRecordInvoicePayment, canReverseInvoicePayment } from "@/lib/invoices";
import { paidTotalKopeks, remainingKopeks, derivedInvoiceStatus, validatePaymentAmount, INVOICE_PAYMENT_SOURCES } from "@/lib/invoice-payments";
import { applyInvoicePaymentInTx, applyInvoicePaymentReversalInTx } from "@/lib/invoices/payment-ledger";
import { findInvoiceDuplicates } from "@/lib/invoice-dedupe";
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
  canReviewInvoiceData,
  invoiceFinancialSnapshot,
  invoiceFinancialFingerprint,
  invoiceFinancialFieldsChanged,
  invoicePaymentBlockedReason,
  INVOICE_ACTION_AUDIT,
  INVOICE_EDITABLE_STATUSES,
  INVOICE_REVIEW_DATA_STATUSES,
  INVOICE_APPROVED_UNPAID_STATUSES,
  INVOICE_RETURN_REASON_MIN,
  type InvoiceAction,
} from "@/lib/invoices";
import { getClubLegalEntities } from "@/lib/legal-entities";
import { monthClosedError } from "@/lib/month-close";
import { notifyRegionalReview, notifyAuthor } from "@/lib/notifications/events";
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
import { isRateLimited } from "@/lib/rate-limit";

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

// How long a persisted-but-unsubmitted invoice upload stays claimable. After this
// it can no longer be consumed and becomes eligible for background cleanup.
const INVOICE_UPLOAD_TTL_HOURS = 24;

// Thrown inside the create transaction when the upload reference cannot be
// consumed (foreign / out-of-scope / expired / already used). Caught to map to a
// safe message — never leaks which condition failed.
class InvoiceUploadUnavailable extends Error {}

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

    // Cost-abuse guard: cap AI document-analysis per user AND per company BEFORE any
    // external AI call. Exceeding never charges a Yandex/OpenAI request.
    if (await isRateLimited("ai_analyze", "user", ctx.user.id)) return fail("RATE_LIMITED");
    if (ctx.selectedCompanyId && (await isRateLimited("ai_analyze_company", "company", ctx.selectedCompanyId))) return fail("RATE_LIMITED");

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
      // Record server-side ownership of this upload so the later create step can
      // prove the file belongs to THIS user + scope (never trusting the client
      // storage key). Consumed single-use at invoice creation; expires in 24h.
      await prisma.pendingInvoiceUpload.create({
        data: {
          storageKey: stored.storageKey,
          uploadedByUserId: ctx.user.id,
          companyId: ctx.selectedCompanyId ?? "",
          clubId,
          purpose: "invoice",
          originalFileName: file.name,
          originalFileMime: file.type,
          originalFileSize: stored.size,
          expiresAt: new Date(Date.now() + INVOICE_UPLOAD_TTL_HOURS * 60 * 60 * 1000),
        },
      });
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

  // File binding: the client sends only the storage key; the SERVER proves the
  // upload belongs to this user + scope via the PendingInvoiceUpload row (created
  // when the file was persisted). A guessed / substituted / foreign key never
  // matches, so an invoice can never reference someone else's document.
  const storageKey = str(formData, "storageKey");
  const now = new Date();
  const pending = storageKey
    ? await prisma.pendingInvoiceUpload.findUnique({ where: { storageKey } })
    : null;
  const validUpload =
    !!pending &&
    pending.uploadedByUserId === ctx.user.id &&
    pending.companyId === companyId &&
    pending.clubId === clubId &&
    pending.purpose === "invoice" &&
    pending.consumedAt === null &&
    pending.expiresAt > now;

  // Same minimum-data gate the submit-for-review used, applied up-front so an
  // incomplete invoice is never created. AI confidence is NOT a gate. A missing
  // OR unauthorized upload both read as "no file" (no enumeration of foreign keys).
  const blocked = invoiceSubmitBlockedReason({
    counterpartyName: parsed.data.counterpartyName,
    amountKopeks: parsed.data.amountKopeks,
    hasFile: validUpload,
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

  // File metadata is taken from the server-owned PendingInvoiceUpload, NOT the
  // client form. pending is guaranteed non-null here (validUpload passed the gate).
  const bound = pending!;

  let invoice;
  try {
    invoice = await prisma.$transaction(async (tx) => {
      // Single-use consume: only an unconsumed, unexpired upload owned by this
      // user + scope can be claimed. Atomic with the invoice create — a DB error
      // rolls back BOTH (the upload stays claimable, no orphan invoice).
      const consumed = await tx.pendingInvoiceUpload.updateMany({
        where: {
          storageKey: bound.storageKey,
          uploadedByUserId: ctx.user.id,
          companyId,
          clubId,
          purpose: "invoice",
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new InvoiceUploadUnavailable();

      return tx.invoice.create({
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
          // File fields come from the server-owned upload record only.
          originalFileName: bound.originalFileName,
          originalFileMime: bound.originalFileMime,
          originalFileSize: bound.originalFileSize,
          originalFileStorageKey: bound.storageKey,
          rawExtractedJson: str(formData, "rawExtractedJson"),
        },
      });
    });
  } catch (error) {
    // Concurrent double-submit that raced past the pre-check: the unique key
    // rejects the second create — return the row the winner made (upload consume
    // was rolled back with it, so the winner's file binding stays intact).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && clientSubmissionId) {
      const dup = await prisma.invoice.findUnique({ where: { clientSubmissionId }, select: { id: true } });
      if (dup) return { ok: true, invoiceId: dup.id };
    }
    // Upload became unclaimable mid-flight. If this same submission already
    // produced an invoice (idempotent retry / race loser), return it; otherwise
    // ask the user to re-upload — never revealing why the reference failed.
    if (error instanceof InvoiceUploadUnavailable) {
      if (clientSubmissionId) {
        const dup = await prisma.invoice.findUnique({ where: { clientSubmissionId }, select: { id: true } });
        if (dup) return { ok: true, invoiceId: dup.id };
      }
      return { ok: false, error: "Файл счёта не найден или недоступен. Загрузите документ заново." };
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

  // Notify the regional director(s) that a new invoice awaits review (best-effort).
  await notifyRegionalReview({ resourceType: "invoice", resourceId: invoice.id, companyId, clubId, amountKopeks: invoice.amountKopeks, actorUserId: ctx.user.id, isResubmit: false });

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

  const totalKopeks = rublesToKopeks(amount);
  // Paid amount — defaults to the full total; a smaller value creates a partially_paid entry.
  const paidRaw = String(formData.get("paidAmount") ?? "").trim().replace(",", ".");
  const paidAmount = paidRaw === "" ? amount : Number(paidRaw);
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) return { ok: false, error: "Укажите положительную оплаченную сумму" };
  const paidKopeks = rublesToKopeks(paidAmount);
  if (paidKopeks > totalKopeks) return { ok: false, error: "Оплаченная сумма не может превышать сумму счёта" };
  const histSource = ["edo", "bank", "other"].includes(str(formData, "source") ?? "") ? str(formData, "source")! : "other";
  const histStatus = paidKopeks >= totalKopeks ? "paid" : "partially_paid";

  // §11 duplicate guard. Exact (file hash / EDO id) always blocks; probable (INN+number+
  // date+total) requires an explicit confirm. Weak matches pass. Overrides are audited.
  const confirmDuplicate = str(formData, "confirmDuplicate") === "1";
  const dupes = await findInvoiceDuplicates(companyId, {
    counterpartyInn: str(formData, "counterpartyInn"), invoiceNumber: str(formData, "invoiceNumber"),
    invoiceDateIso: invoiceDate.toISOString().slice(0, 10), amountKopeks: totalKopeks,
    fileHash: str(formData, "fileHash"), edoDocumentId: str(formData, "edoDocumentId"),
  });
  const exact = dupes.find((d) => d.level === "exact");
  const probable = dupes.find((d) => d.level === "probable");
  if (exact) return { ok: false, error: "Точный дубль: такой счёт уже есть в системе (совпал файл или ЭДО-ID)." };
  if (probable && !confirmDuplicate) {
    return { ok: false, error: `Вероятный дубль: счёт «${probable.number ?? "—"}» с той же суммой уже существует. Подтвердите повторно, чтобы всё равно добавить.` };
  }
  if (probable && confirmDuplicate) {
    await recordAudit({ action: "invoice.duplicate_override", entityType: "Invoice", entityId: probable.invoiceId, companyId, clubId, userId: ctx.user.id, metadata: { level: "probable" } });
  }

  const invoice = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.create({
      data: {
        companyId, clubId, createdByUserId: ctx.user.id, legalEntityId,
        counterpartyName: str(formData, "counterpartyName"), counterpartyInn: str(formData, "counterpartyInn"),
        amountKopeks: totalKopeks, currency: "RUB", expenseCategory: str(formData, "expenseCategory"),
        // Expense belongs to its period; money may leave in a different month.
        expensePeriod: resolveExpensePeriod(formData, invoiceDate),
        invoiceNumber: str(formData, "invoiceNumber"), invoiceDate,
        paidAt: histStatus === "paid" ? paidAt : null,
        // Post-factum entry: no approval workflow; status derived from the paid amount.
        status: histStatus, confidence: "high", comment: str(formData, "comment"),
      },
    });
    // The cash-payment fact — entered after the money left the account.
    await tx.invoicePayment.create({
      data: { companyId, invoiceId: inv.id, amountKopeks: paidKopeks, paymentDate: paidAt, source: histSource, comment: str(formData, "comment"), createdById: ctx.user.id, status: "confirmed", enteredAfterPayment: true, idempotencyKey: str(formData, "idempotencyKey") || randomUUID() },
    });
    return inv;
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

// ===================== Payments: full / partial / multiple (§3–§5) =====================
type PaymentState = { ok: boolean; error?: string };

/** Sum the confirmed/reversed payments of an invoice → paidTotal + remaining. */
async function loadPaymentAggregate(invoiceId: string): Promise<{ payments: { id: string; status: string; amountKopeks: number }[]; paid: number }> {
  const payments = await prisma.invoicePayment.findMany({ where: { invoiceId }, select: { id: true, status: true, amountKopeks: true } });
  return { payments, paid: paidTotalKopeks(payments) };
}

/**
 * «Отметить оплату» — record a full or partial payment (accountant / chief). Creates an
 * append-only InvoicePayment (confirmed), recomputes paidTotal and derives the invoice
 * status (approved → partially_paid → paid). Never lets the actor pick the final status.
 * idempotencyKey blocks a double submit. Payable only from an approved / partially_paid state.
 */
export async function recordInvoicePayment(_prev: PaymentState | undefined, formData: FormData): Promise<PaymentState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) return { ok: false, error: "Нет доступа" };
  if (!canRecordInvoicePayment(ctx.effectiveRoles)) return { ok: false, error: "Отметить оплату может только бухгалтер или главный бухгалтер." };

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  const invoice = await getInvoiceForContext(ctx, invoiceId);
  if (!invoice) return { ok: false, error: "Счёт не найден или нет доступа" };
  const PAYABLE = ["approved_by_regional", "approved_by_chief_accountant", "approved_by_owner", "partially_paid"];
  if (!PAYABLE.includes(invoice.status)) return { ok: false, error: "Оплату можно отметить только по согласованному или частично оплаченному счёту." };

  // REM-08 — the AI-review/approval-fingerprint payment guard (moved here from the
  // retired transition «pay»): a low-confidence unreviewed invoice, or one whose
  // financial data changed after approval (fingerprint mismatch), cannot be paid.
  {
    const currentFingerprint = invoiceFinancialFingerprint(invoiceFinancialSnapshot(invoice));
    const blockedReason = invoicePaymentBlockedReason({
      confidence: invoice.confidence,
      aiDataReviewedAt: invoice.aiDataReviewedAt,
      amountKopeks: invoice.amountKopeks,
      counterpartyName: invoice.counterpartyName,
      counterpartyInn: invoice.counterpartyInn,
      payerName: invoice.payerName,
      counterpartyBankBik: invoice.counterpartyBankBik,
      counterpartyAccount: invoice.counterpartyAccount,
      approvedDataFingerprint: invoice.approvedDataFingerprint,
      currentFingerprint,
    });
    if (blockedReason) return { ok: false, error: blockedReason };
  }

  const paymentDate = parseDate(str(formData, "paymentDate"));
  if (!paymentDate) return { ok: false, error: "Укажите дату платежа." };
  const closed = await monthClosedError(invoice.companyId, invoice.clubId, paymentDate);
  if (closed) return { ok: false, error: closed };
  const source = INVOICE_PAYMENT_SOURCES.includes(str(formData, "source") as never) ? str(formData, "source")! : "bank";
  const mode = str(formData, "mode") === "partial" ? "partial" : "full";
  const idempotencyKey = str(formData, "idempotencyKey") || randomUUID();

  const { paid } = await loadPaymentAggregate(invoice.id);
  const remaining = invoice.amountKopeks - paid;
  // Full payment → amount = remaining; partial → amount from the form.
  let amountKopeks = remaining;
  if (mode === "partial") {
    const raw = String(formData.get("amount") ?? "").trim().replace(",", ".");
    const n = raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: "Укажите сумму платежа." };
    amountKopeks = rublesToKopeks(n);
  }
  const invalid = validatePaymentAmount(amountKopeks, remaining, mode);
  if (invalid === "no_remaining") return { ok: false, error: "Счёт уже полностью оплачен." };
  if (invalid === "not_positive") return { ok: false, error: "Сумма платежа должна быть больше нуля." };
  if (invalid === "over_remaining") return { ok: false, error: `Сумма платежа не может превышать остаток ${(remaining / 100).toFixed(2)} ₽.` };

  try {
    // REM-08 — single ledger service: creates the confirmed InvoicePayment + syncs the
    // derived status/paidAt atomically. Idempotency via the @unique idempotencyKey.
    await prisma.$transaction(async (tx) => {
      await applyInvoicePaymentInTx(tx, {
        invoice: { id: invoice.id, companyId: invoice.companyId, amountKopeks: invoice.amountKopeks, status: invoice.status, prePaymentStatus: invoice.prePaymentStatus ?? null, paidAt: invoice.paidAt ?? null },
        amountKopeks, paymentDate, source, method: str(formData, "method"), comment: str(formData, "comment"), createdById: ctx.user.id, idempotencyKey,
      });
    });
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") return { ok: true }; // duplicate submit
    throw e;
  }

  await recordAudit({ action: "invoice.payment_recorded", entityType: "Invoice", entityId: invoice.id, companyId: invoice.companyId, clubId: invoice.clubId, userId: ctx.user.id, metadata: { amountKopeks, mode, source, paymentDate: paymentDate.toISOString().slice(0, 10) } });
  revalidateInvoiceFinancial();
  return { ok: true };
}

/**
 * «Сторнировать платёж» — chief accountant ONLY (§7). Flips a specific confirmed payment to
 * `reversed` (append-only — never deleted), records who/when/why, recomputes paidTotal and the
 * derived invoice status. A reason is required.
 */
export async function reverseInvoicePayment(_prev: PaymentState | undefined, formData: FormData): Promise<PaymentState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) return { ok: false, error: "Нет доступа" };
  if (!canReverseInvoicePayment(ctx.effectiveRoles)) return { ok: false, error: "Сторнировать платёж может только главный бухгалтер." };
  const paymentId = String(formData.get("paymentId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { ok: false, error: "Укажите причину сторно." };

  const payment = await prisma.invoicePayment.findUnique({ where: { id: paymentId }, select: { id: true, invoiceId: true, companyId: true, status: true } });
  if (!payment) return { ok: false, error: "Платёж не найден." };
  const invoice = await getInvoiceForContext(ctx, payment.invoiceId); // tenant + scope check
  if (!invoice) return { ok: false, error: "Счёт не найден или нет доступа" };
  const closed = await monthClosedError(invoice.companyId, invoice.clubId, invoice.invoiceDate ?? invoice.createdAt);
  if (closed) return { ok: false, error: closed };

  await prisma.$transaction(async (tx) => {
    // REM-08 — single ledger service: append-only reversal + status re-sync.
    const r = await applyInvoicePaymentReversalInTx(tx, {
      invoice: { id: invoice.id, companyId: invoice.companyId, amountKopeks: invoice.amountKopeks, status: invoice.status, prePaymentStatus: invoice.prePaymentStatus ?? null, paidAt: invoice.paidAt ?? null },
      paymentId: payment.id, reversedById: ctx.user.id, reason,
    });
    if (!r.ok) throw new Error("already");
  }).catch(() => null);

  await recordAudit({ action: "invoice.payment_reversed", entityType: "Invoice", entityId: invoice.id, companyId: invoice.companyId, clubId: invoice.clubId, userId: ctx.user.id, metadata: { paymentId: payment.id, reason: reason.slice(0, 200) } });
  revalidateInvoiceFinancial();
  return { ok: true };
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

  const before = invoiceFinancialSnapshot(existing);
  const after = invoiceFinancialSnapshot({ ...existing, ...parsed.data });
  const changed = invoiceFinancialFieldsChanged(before, after);

  // A PAID invoice's financial fields (amount, counterparty, payer, legal entity,
  // bank requisites) are immutable — post-payment corrections are out of scope for
  // this change. Non-financial edits (notes) remain allowed.
  if (existing.status === "paid" && changed) {
    return { ok: false, error: "Оплаченный счёт: сумму, контрагента, плательщика, юрлицо и банковские реквизиты изменять нельзя." };
  }

  const data: Record<string, unknown> = { ...parsed.data };
  // Any financial change invalidates a prior manual AI review (server-side reset).
  if (changed && existing.aiDataReviewedAt) {
    data.aiDataReviewedAt = null;
    data.aiDataReviewedById = null;
  }
  await prisma.invoice.update({ where: { id: invoiceId }, data });

  if (changed) {
    await recordAudit({
      action: "invoice.financial_data_changed",
      entityType: "Invoice", entityId: invoiceId,
      companyId: existing.companyId, clubId: existing.clubId, userId: ctx.user.id,
      metadata: invoiceChangeMetadata(existing, after),
    });
    if (existing.aiDataReviewedAt) {
      await recordAudit({
        action: "invoice.ai_review_invalidated", entityType: "Invoice", entityId: invoiceId,
        companyId: existing.companyId, clubId: existing.clubId, userId: ctx.user.id,
        metadata: { reason: "financial_data_changed" },
      });
    }
  } else {
    await recordAudit({
      action: "invoice.updated", entityType: "Invoice", entityId: invoiceId,
      companyId: existing.companyId, clubId: existing.clubId, userId: ctx.user.id,
    });
  }

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/dashboard");
  revalidatePath("/analytics");
  return { ok: true, invoiceId };
}

// Digits-only soft normalization for requisites (ИНН/КПП/БИК/счёт). Empty → null.
// Soft: strips separators/spaces but never rejects the save.
function digits(value: string | null): string | null {
  if (!value) return null;
  const d = value.replace(/\D+/g, "");
  return d || null;
}

// Mask a bank account/requisite for the audit — only the last 4 digits survive.
// Never store a full расчётный/корр. счёт in the audit payload.
function maskAccount(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = String(value).replace(/\D+/g, "");
  if (!d) return null;
  return d.length <= 4 ? `••${d}` : `••••${d.slice(-4)}`;
}

type InvoiceFinancialLike = Parameters<typeof invoiceFinancialSnapshot>[0];

// Safe before/after payload for a financial-data change audit. Accounts are masked
// (last 4 only); no raw AI JSON / prompts / documents / secrets are ever included.
function invoiceChangeMetadata(beforeInv: InvoiceFinancialLike, after: ReturnType<typeof invoiceFinancialSnapshot>) {
  const before = invoiceFinancialSnapshot(beforeInv);
  const changedFields: string[] = [];
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const track = (key: string, bv: unknown, av: unknown) => { if (String(bv ?? "") !== String(av ?? "")) changedFields.push(key); };
  track("amountKopeks", before.amountKopeks, after.amountKopeks);
  track("counterpartyName", before.counterpartyName, after.counterpartyName);
  track("counterpartyInn", before.counterpartyInn, after.counterpartyInn);
  track("counterpartyKpp", before.counterpartyKpp, after.counterpartyKpp);
  track("payerName", before.payerName, after.payerName);
  track("counterpartyBankName", before.counterpartyBankName, after.counterpartyBankName);
  track("counterpartyBankBik", before.counterpartyBankBik, after.counterpartyBankBik);
  track("counterpartyAccount", before.counterpartyAccount, after.counterpartyAccount);
  track("counterpartyCorrAccount", before.counterpartyCorrAccount, after.counterpartyCorrAccount);
  track("invoiceNumber", before.invoiceNumber, after.invoiceNumber);
  track("invoiceDate", day(before.invoiceDate), day(after.invoiceDate));
  track("dueDate", day(before.dueDate), day(after.dueDate));
  track("subject", before.subject, after.subject);
  track("legalEntityId", before.legalEntityId, after.legalEntityId);
  return {
    changedFields,
    amount: { from: before.amountKopeks, to: after.amountKopeks },
    counterparty: { from: before.counterpartyName, to: after.counterpartyName },
    inn: { from: before.counterpartyInn, to: after.counterpartyInn },
    payer: { from: before.payerName, to: after.payerName },
    bik: { from: before.counterpartyBankBik, to: after.counterpartyBankBik },
    account: { from: maskAccount(before.counterpartyAccount), to: maskAccount(after.counterpartyAccount) },
    corrAccount: { from: maskAccount(before.counterpartyCorrAccount), to: maskAccount(after.counterpartyCorrAccount) },
  };
}

/**
 * Accountant / chief_accountant / owner review of the AI-extracted invoice fields
 * ("Данные счёта"). Saves the (possibly corrected) fields and stamps
 * aiDataReviewedAt / aiDataReviewedById — which lifts the low-confidence payment
 * guard in transitionInvoice. Does NOT change the invoice status.
 *
 * Distinct from updateInvoice: allowed for the reviewer roles across the working
 * lifecycle (not just the author in draft / needs_correction), so a paid or
 * approved invoice's data can still be verified. Scope + role + status enforced
 * server-side; requisites are digits-normalized; the amount stays non-negative.
 */
export async function reviewInvoiceData(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return { ok: false, error: "Нет доступа" };
  }
  // Only the accountant / chief accountant review the extracted data. Owner is
  // strategic read-only (views the data but never edits/signs off); a manager
  // (author) prepares the invoice but does not sign off on it here.
  if (!canReviewInvoiceData(ctx.effectiveRoles)) {
    return { ok: false, error: "Проверять и сохранять данные счёта может только бухгалтер." };
  }

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  // Scoped loader: enforces selectedCompanyId + allowedClubIds. A foreign or
  // out-of-scope invoiceId resolves to null → no cross-company edit / id spoof.
  const existing = await getInvoiceForContext(ctx, invoiceId);
  if (!existing) return { ok: false, error: "Счёт не найден или нет доступа" };

  // Review is possible across the working lifecycle but not on rejected/canceled.
  if (!(INVOICE_REVIEW_DATA_STATUSES as readonly string[]).includes(existing.status)) {
    return { ok: false, error: "Данные этого счёта нельзя редактировать" };
  }

  const closed = await monthClosedError(existing.companyId, existing.clubId, existing.invoiceDate ?? existing.createdAt);
  if (closed) return { ok: false, error: closed };

  const parsed = parseInvoiceFields(formData);
  if (parsed.error || !parsed.data) return { ok: false, error: parsed.error ?? "Ошибка данных" };

  // A payment due date shouldn't precede the invoice date (both are optional).
  if (parsed.data.invoiceDate && parsed.data.dueDate && parsed.data.dueDate < parsed.data.invoiceDate) {
    return { ok: false, error: "Срок оплаты не может быть раньше даты счёта" };
  }

  // The fields being written (payer/subject + digits-normalized requisites).
  const writtenFields = {
    ...parsed.data,
    counterpartyInn: digits(parsed.data.counterpartyInn),
    counterpartyKpp: digits(parsed.data.counterpartyKpp),
    counterpartyBankBik: digits(parsed.data.counterpartyBankBik),
    counterpartyAccount: digits(parsed.data.counterpartyAccount),
    counterpartyCorrAccount: digits(parsed.data.counterpartyCorrAccount),
    payerName: str(formData, "payerName"),
    payerInn: digits(str(formData, "payerInn")),
    payerKpp: digits(str(formData, "payerKpp")),
    subject: str(formData, "subject"),
  };

  const after = invoiceFinancialSnapshot({ ...existing, ...writtenFields });
  const changed = invoiceFinancialFieldsChanged(invoiceFinancialSnapshot(existing), after);
  // Editing an approved-but-unpaid invoice's financial data voids the approval — it
  // must be re-approved (and re-fingerprinted) before it can be paid again.
  const invalidateApproval = changed && (INVOICE_APPROVED_UNPAID_STATUSES as readonly string[]).includes(existing.status);

  const data: Record<string, unknown> = {
    ...writtenFields,
    // The reviewer signs off on the (possibly corrected) values saved NOW.
    aiDataReviewedAt: new Date(),
    aiDataReviewedById: ctx.user.id,
    aiDataReviewNote: str(formData, "aiDataReviewNote"),
  };
  if (invalidateApproval) {
    data.status = "needs_review";
    data.approvedDataFingerprint = null;
  }

  // Compare-and-set on the current status so a concurrent transition is never lost.
  const updated = await prisma.invoice.updateMany({ where: { id: invoiceId, status: existing.status }, data });
  if (updated.count === 0) return { ok: false, error: "Статус счёта изменился. Обновите страницу." };

  if (changed) {
    await recordAudit({
      action: "invoice.financial_data_changed", entityType: "Invoice", entityId: invoiceId,
      companyId: existing.companyId, clubId: existing.clubId, userId: ctx.user.id,
      metadata: invoiceChangeMetadata(existing, after),
    });
  }
  if (invalidateApproval) {
    await recordAudit({
      action: "invoice.approval_invalidated", entityType: "Invoice", entityId: invoiceId,
      companyId: existing.companyId, clubId: existing.clubId, userId: ctx.user.id,
      metadata: { from: existing.status, to: "needs_review", reason: "financial_data_changed" },
    });
  }
  await recordAudit({
    action: "invoice.ai_data_reviewed",
    entityType: "Invoice",
    entityId: invoiceId,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
    metadata: { confidence: existing.confidence, wasReviewed: Boolean(existing.aiDataReviewedAt), fieldsChanged: changed, approvalInvalidated: invalidateApproval },
  });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/dashboard");
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
      // A replaced document may change the invoice content → any prior manual AI
      // review no longer applies to the new file (server-side reset).
      aiDataReviewedAt: null,
      aiDataReviewedById: null,
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

// §8: a paid / partially_paid invoice can NO LONGER be cancelled via the legacy path — the
// only adjustment is reversing a specific payment (chief accountant). No status here that has
// a confirmed payment. Invoices are never hard-deleted; payment history is preserved.
const INVOICE_CANCELABLE = ["draft", "needs_review", "approved_by_regional", "approved_by_chief_accountant", "approved_by_owner"];

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

  if (existing.status === "paid" || existing.status === "partially_paid") {
    return { ok: false, error: "Оплаченный (или частично оплаченный) счёт нельзя отменить — сторнируйте конкретный платёж (главный бухгалтер)." };
  }
  if (!INVOICE_CANCELABLE.includes(existing.status)) {
    return { ok: false, error: "Этот счёт нельзя отменить" };
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
  // REM-08 — the legacy binary «pay» transition is RETIRED. It used to flip
  // Invoice.status="paid" + paidAt WITHOUT creating an InvoicePayment (ARCH-010/
  // DATA-005/FIN-006). Payment is now recorded ONLY through the ledger service
  // (recordInvoicePayment / InvoicePaymentPanel), so status can never reach "paid"
  // without a confirmed payment row. This endpoint no longer marks anything paid.
  if (action === "pay") {
    return { ok: false, error: "Оплата отмечается через реестр платежей: откройте счёт и нажмите «Добавить оплату»." };
  }

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

  // (REM-08: the AI-review/fingerprint PAYMENT guard moved to recordInvoicePayment —
  // the only path that can now mark an invoice paid, via the ledger.)

  // Conditional (compare-and-set) update on the exact current status: only one
  // concurrent request can flip the status. A stale/duplicate submit updates 0
  // rows and gets a clear "already changed" message — never a raw Prisma error.
  const data: {
    status: string; paidAt: Date | null;
    correctionComment?: string; correctionRequestedAt?: Date; correctionRequestedByUserId?: string;
    approvedDataFingerprint?: string;
  } = { status: result.to, paidAt: result.to === "paid" ? new Date() : null };
  if (action === "return_for_correction") {
    data.correctionComment = returnReason;
    data.correctionRequestedAt = new Date();
    data.correctionRequestedByUserId = ctx.user.id;
  }
  if (action === "approve") {
    // Bind the approval to the EXACT financial data approved. Any later edit moves
    // the invoice back to needs_review AND clears/changes this, so a stale approval
    // can never authorize a payment of changed data (defence-in-depth at pay time).
    data.approvedDataFingerprint = invoiceFinancialFingerprint(invoiceFinancialSnapshot(existing));
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

  // Notify the invoice author when a regional approves it or returns it for
  // correction (best-effort; never notifies the actor themselves).
  if (action === "approve" && result.to === "approved_by_regional") {
    await notifyAuthor({ resourceType: "invoice", resourceId: invoiceId, companyId: existing.companyId, clubId: existing.clubId, amountKopeks: existing.amountKopeks, authorUserId: existing.createdByUserId, actorUserId: ctx.user.id, event: "approved" });
  } else if (action === "return_for_correction") {
    await notifyAuthor({ resourceType: "invoice", resourceId: invoiceId, companyId: existing.companyId, clubId: existing.clubId, amountKopeks: existing.amountKopeks, authorUserId: existing.createdByUserId, actorUserId: ctx.user.id, event: "returned" });
  }

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

  // A financial-field change OR a replaced file means the previously-reviewed data
  // no longer matches — the manual AI review is reset (re-verified after review).
  const fieldsChanged = invoiceFinancialFieldsChanged(
    invoiceFinancialSnapshot(existing),
    invoiceFinancialSnapshot({ ...existing, ...parsed.data }),
  );
  const contentChanged = fieldsChanged || Boolean(newStored);

  // Single compare-and-set: fields + (optional) file metadata + status flip, only
  // while STILL this author's needs_correction invoice. No partial state.
  const data: Record<string, unknown> = { ...parsed.data, status: "needs_review" };
  if (contentChanged && existing.aiDataReviewedAt) {
    data.aiDataReviewedAt = null;
    data.aiDataReviewedById = null;
  }
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
  if (fieldsChanged) {
    await recordAudit({
      action: "invoice.financial_data_changed", entityType: "Invoice", entityId: invoiceId,
      companyId: existing.companyId, clubId: existing.clubId, userId: ctx.user.id,
      metadata: invoiceChangeMetadata(existing, invoiceFinancialSnapshot({ ...existing, ...parsed.data })),
    });
  }
  if (contentChanged && existing.aiDataReviewedAt) {
    await recordAudit({
      action: "invoice.ai_review_invalidated", entityType: "Invoice", entityId: invoiceId,
      companyId: existing.companyId, clubId: existing.clubId, userId: ctx.user.id,
      metadata: { reason: fieldsChanged ? "financial_data_changed" : "file_replaced" },
    });
  }

  // Notify the regional director(s) that a corrected invoice was resubmitted.
  await notifyRegionalReview({ resourceType: "invoice", resourceId: invoiceId, companyId: existing.companyId, clubId: existing.clubId, amountKopeks: parsed.data.amountKopeks, actorUserId: ctx.user.id, isResubmit: true });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/dashboard");
  return { ok: true, invoiceId };
}
