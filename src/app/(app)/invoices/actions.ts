"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import {
  getCurrentAccessContext,
  canAccessClub,
  recordAudit,
} from "@/lib/access";
import {
  getInvoiceForContext,
  applyInvoiceAction,
  canEditInvoice,
  INVOICE_ACTION_AUDIT,
  type InvoiceAction,
} from "@/lib/invoices";
import { getClubLegalEntities } from "@/lib/legal-entities";
import {
  analyzeInvoiceDocument,
  type InvoiceExtraction,
} from "@/lib/ai/invoice-analyzer";
import { comparePayer, type PayerMatch } from "@/lib/ai/invoice-party";
import { validateInvoiceFile, persistInvoiceFile } from "@/lib/invoice-storage";
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
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  dueDate: Date | null;
  notes: string | null;
};

function parseInvoiceFields(formData: FormData): { data?: ParsedFields; error?: string } {
  const amountRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const amount = amountRaw === "" ? 0 : Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "Сумма должна быть неотрицательным числом" };
  }
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
      invoiceNumber: str(formData, "invoiceNumber"),
      invoiceDate: parseDate(str(formData, "invoiceDate")),
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
        metadata: { confidence: extraction.confidence, mode: extraction.mode },
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

export async function saveInvoice(
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

  // Legal entity: only honour one that is attached to this club.
  let legalEntityId: string | null = null;
  const requestedEntityId = str(formData, "legalEntityId");
  if (requestedEntityId) {
    const attached = await getClubLegalEntities(clubId);
    legalEntityId = attached.some((e) => e.id === requestedEntityId) ? requestedEntityId : null;
  }

  const confidenceRaw = String(formData.get("confidence") ?? "low");
  const confidence = ["low", "medium", "high"].includes(confidenceRaw) ? confidenceRaw : "low";

  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      clubId,
      createdByUserId: ctx.user.id,
      ...parsed.data,
      legalEntityId,
      status: "draft",
      confidence,
      payerName: str(formData, "payerName"),
      payerInn: str(formData, "payerInn"),
      payerKpp: str(formData, "payerKpp"),
      originalFileName: str(formData, "fileName"),
      originalFileMime: str(formData, "fileMime"),
      originalFileSize: Number(formData.get("fileSize")) || null,
      originalFileStorageKey: str(formData, "storageKey"),
      rawExtractedJson: str(formData, "rawExtractedJson"),
    },
  });

  await recordAudit({
    action: "invoice.created",
    entityType: "Invoice",
    entityId: invoice.id,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { confidence, amountKopeks: invoice.amountKopeks },
  });

  revalidatePath("/invoices");
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

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  const existing = await getInvoiceForContext(ctx, invoiceId);
  if (!existing) return { ok: false, error: "Счёт не найден или нет доступа" };

  if (!canEditInvoice(existing.status, ctx.effectiveRoles)) {
    return { ok: false, error: "Оплаченный счёт может редактировать только владелец или бухгалтер" };
  }

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

export async function transitionInvoice(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    throw new Error("Нет доступа");
  }

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  const action = String(formData.get("action") ?? "").trim() as InvoiceAction;
  if (!(action in INVOICE_ACTION_AUDIT)) throw new Error("Неверное действие");

  const existing = await getInvoiceForContext(ctx, invoiceId);
  if (!existing) throw new Error("Счёт не найден или нет доступа");

  const result = applyInvoiceAction(action, existing.status, ctx.effectiveRoles);
  if (!result.ok) throw new Error(result.error);

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: result.to, paidAt: result.to === "paid" ? new Date() : null },
  });

  await recordAudit({
    action: INVOICE_ACTION_AUDIT[action],
    entityType: "Invoice",
    entityId: invoiceId,
    companyId: existing.companyId,
    clubId: existing.clubId,
    userId: ctx.user.id,
    metadata: { from: existing.status, to: result.to, action },
  });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
}
