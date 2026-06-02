"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { type InvoiceStatus } from "@/lib/invoices";
import { getCurrentAccessContext, canAccessClub } from "@/lib/access";

export type CreateInvoiceState = {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<
    "clubId" | "counterpartyName" | "subject" | "amount" | "invoiceDate" | "dueDate",
    string
  >>;
};

function parseDateInput(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function createInvoice(
  _prev: CreateInvoiceState | undefined,
  formData: FormData,
): Promise<CreateInvoiceState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return { ok: false, error: "Нет доступа" };
  }
  const user = ctx.user;

  const clubId = String(formData.get("clubId") ?? "").trim();
  const counterpartyName = String(formData.get("counterpartyName") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const invoiceDateRaw = String(formData.get("invoiceDate") ?? "").trim();
  const dueDateRaw = String(formData.get("dueDate") ?? "").trim();
  const commentRaw = String(formData.get("comment") ?? "").trim();

  const fieldErrors: CreateInvoiceState["fieldErrors"] = {};

  if (!clubId) fieldErrors.clubId = "Выберите клуб";
  if (!counterpartyName) fieldErrors.counterpartyName = "Укажите контрагента";
  if (!subject) fieldErrors.subject = "Укажите назначение";

  const amount = Number(amountRaw);
  if (!amountRaw || Number.isNaN(amount) || amount <= 0) {
    fieldErrors.amount = "Сумма должна быть положительной";
  }

  const invoiceDate = invoiceDateRaw ? parseDateInput(invoiceDateRaw) : new Date();
  if (invoiceDateRaw && !invoiceDate) fieldErrors.invoiceDate = "Неверная дата";

  if (!dueDateRaw) {
    fieldErrors.dueDate = "Укажите срок оплаты";
  }
  const dueDate = parseDateInput(dueDateRaw);
  if (dueDateRaw && !dueDate) fieldErrors.dueDate = "Неверная дата";

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: "Проверьте поля формы", fieldErrors };
  }

  if (!(await canAccessClub(user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { companyId: true },
  });
  if (!club) return { ok: false, error: "Клуб не найден" };

  await prisma.invoice.create({
    data: {
      companyId: club.companyId,
      clubId,
      createdByUserId: user.id,
      counterpartyName,
      amountKopeks: rublesToKopeks(amount),
      subject,
      invoiceDate: invoiceDate ?? new Date(),
      dueDate: dueDate!,
      comment: commentRaw || null,
      status: "unpaid",
    },
  });

  revalidatePath("/invoices");
  return { ok: true };
}

export async function setInvoiceStatus(invoiceId: string, status: InvoiceStatus): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    throw new Error("Нет доступа");
  }
  const user = ctx.user;

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Счёт не найден");

  if (!(await canAccessClub(user.id, invoice.clubId))) {
    throw new Error("Нет доступа к клубу счёта");
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status,
      paidAt: status === "paid" ? new Date() : null,
    },
  });

  revalidatePath("/invoices");
}
