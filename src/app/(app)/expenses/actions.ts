"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, canAccessPage } from "@/lib/auth";
import { ensureDemoData } from "@/lib/seed";
import { rublesToKopeks } from "@/lib/money";
import { userHasClubAccess } from "@/lib/invoices";

export type CreateExpenseState = {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<
    "clubId" | "category" | "amount" | "expenseDate",
    string
  >>;
};

function parseDateInput(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function createExpense(
  _prev: CreateExpenseState | undefined,
  formData: FormData,
): Promise<CreateExpenseState> {
  const user = await getCurrentUser();
  if (!canAccessPage(user.role, "expenses")) {
    return { ok: false, error: "Нет доступа" };
  }
  await ensureDemoData();

  const clubId = String(formData.get("clubId") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const vendorName = String(formData.get("vendorName") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const expenseDateRaw = String(formData.get("expenseDate") ?? "").trim();
  const paymentMethod = String(formData.get("paymentMethod") ?? "").trim();
  const commentRaw = String(formData.get("comment") ?? "").trim();

  const fieldErrors: CreateExpenseState["fieldErrors"] = {};

  if (!clubId) fieldErrors.clubId = "Выберите клуб";
  if (!category) fieldErrors.category = "Выберите статью";

  const amount = Number(amountRaw);
  if (!amountRaw || Number.isNaN(amount) || amount <= 0) {
    fieldErrors.amount = "Сумма должна быть положительной";
  }

  if (!expenseDateRaw) {
    fieldErrors.expenseDate = "Укажите дату расхода";
  }
  const expenseDate = parseDateInput(expenseDateRaw);
  if (expenseDateRaw && !expenseDate) fieldErrors.expenseDate = "Неверная дата";

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: "Проверьте поля формы", fieldErrors };
  }

  if (!(await userHasClubAccess(user, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }

  await prisma.expense.create({
    data: {
      clubId,
      createdByUserId: user.id,
      category,
      vendorName: vendorName || null,
      amountKopeks: rublesToKopeks(amount),
      expenseDate: expenseDate!,
      paymentMethod: paymentMethod || null,
      comment: commentRaw || null,
    },
  });

  revalidatePath("/expenses");
  return { ok: true };
}
