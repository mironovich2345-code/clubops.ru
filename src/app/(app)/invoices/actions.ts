"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
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
import {
  analyzeInvoiceDocument,
  type InvoiceExtraction,
} from "@/lib/ai/invoice-analyzer";
import { validateInvoiceFile, storeInvoiceFile } from "@/lib/invoice-storage";

type AnalyzeState = {
  ok: boolean;
  error?: string;
  clubId?: string;
  storageKey?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  extraction?: InvoiceExtraction;
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
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return { ok: false, error: "Нет доступа" };
  }

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }

  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Выберите файл" };
  const fileError = validateInvoiceFile(file);
  if (fileError) return { ok: false, error: fileError };

  const stored = await storeInvoiceFile(file);
  const extraction = await analyzeInvoiceDocument({
    buffer: stored.buffer,
    mime: stored.mime,
    fileName: stored.fileName,
  });

  await recordAudit({
    action: "invoice.uploaded",
    entityType: "Invoice",
    companyId: ctx.selectedCompanyId,
    clubId,
    userId: ctx.user.id,
    metadata: { fileName: stored.fileName, mime: stored.mime, size: stored.size },
  });
  await recordAudit({
    action: "invoice.extracted",
    entityType: "Invoice",
    companyId: ctx.selectedCompanyId,
    clubId,
    userId: ctx.user.id,
    metadata: { confidence: extraction.confidence, missingFields: extraction.missingFields },
  });

  return {
    ok: true,
    clubId,
    storageKey: stored.storageKey,
    fileName: stored.fileName,
    fileMime: stored.mime,
    fileSize: stored.size,
    extraction,
  };
}

export async function saveInvoice(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return { ok: false, error: "Нет доступа" };
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

  const confidenceRaw = String(formData.get("confidence") ?? "low");
  const confidence = ["low", "medium", "high"].includes(confidenceRaw) ? confidenceRaw : "low";

  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      clubId,
      createdByUserId: ctx.user.id,
      ...parsed.data,
      status: "draft",
      confidence,
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
