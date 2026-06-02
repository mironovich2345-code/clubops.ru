"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, canAccessPage } from "@/lib/auth";
import { ensureDemoData } from "@/lib/seed";
import { rublesToKopeks } from "@/lib/money";
import { userHasClubAccess } from "@/lib/invoices";

export type CreateSaleState = {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<
    "clubId" | "source" | "amount" | "saleDate",
    string
  >>;
};

function parseDateInput(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function createSale(
  _prev: CreateSaleState | undefined,
  formData: FormData,
): Promise<CreateSaleState> {
  const user = await getCurrentUser();
  if (!canAccessPage(user.role, "sales")) {
    return { ok: false, error: "Нет доступа" };
  }
  await ensureDemoData();

  const clubId = String(formData.get("clubId") ?? "").trim();
  const source = String(formData.get("source") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const saleDateRaw = String(formData.get("saleDate") ?? "").trim();
  const commentRaw = String(formData.get("comment") ?? "").trim();

  const fieldErrors: CreateSaleState["fieldErrors"] = {};

  if (!clubId) fieldErrors.clubId = "Выберите клуб";
  if (!source) fieldErrors.source = "Выберите источник";

  const amount = Number(amountRaw);
  if (!amountRaw || Number.isNaN(amount) || amount <= 0) {
    fieldErrors.amount = "Сумма должна быть положительной";
  }

  if (!saleDateRaw) {
    fieldErrors.saleDate = "Укажите дату продажи";
  }
  const saleDate = parseDateInput(saleDateRaw);
  if (saleDateRaw && !saleDate) fieldErrors.saleDate = "Неверная дата";

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: "Проверьте поля формы", fieldErrors };
  }

  if (!(await userHasClubAccess(user, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }

  await prisma.sale.create({
    data: {
      clubId,
      createdByUserId: user.id,
      source,
      amountKopeks: rublesToKopeks(amount),
      saleDate: saleDate!,
      comment: commentRaw || null,
    },
  });

  revalidatePath("/sales");
  return { ok: true };
}
