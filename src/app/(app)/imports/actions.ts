"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { getCurrentAccessContext, canAccessClub } from "@/lib/access";
import { isUploadedFile } from "@/lib/uploaded-file";
import {
  parseImportBuffer,
  type ImportCandidate,
  type ImportPreview,
} from "@/lib/import";

export type PreviewState = {
  ok: boolean;
  error?: string;
  clubId?: string;
  preview?: ImportPreview;
};

export type ImportResultState = {
  ok: boolean;
  error?: string;
  importedSales?: number;
  importedExpenses?: number;
  skipped?: number;
};

export async function previewImport(
  _prev: PreviewState | undefined,
  formData: FormData,
): Promise<PreviewState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "imports")) {
    return { ok: false, error: "Нет доступа" };
  }
  const user = ctx.user;

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId) return { ok: false, error: "Выберите клуб" };
  if (!(await canAccessClub(user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }

  const file = formData.get("file");
  if (!isUploadedFile(file) || file.size === 0) {
    return { ok: false, error: "Выберите файл .xlsx или .csv" };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const preview = parseImportBuffer(buffer);

  return { ok: true, clubId, preview };
}

function dayKey(dateISO: string, label: string, amountKopeks: number): string {
  return `${dateISO}|${label}|${amountKopeks}`;
}

function isoFromDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateFromISO(dateISO: string): Date {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(y, m - 1, d); // local midnight
}

export async function runImport(
  _prev: ImportResultState | undefined,
  formData: FormData,
): Promise<ImportResultState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "imports")) {
    return { ok: false, error: "Нет доступа" };
  }
  const user = ctx.user;

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId) return { ok: false, error: "Не указан клуб" };
  if (!(await canAccessClub(user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { companyId: true },
  });
  if (!club) return { ok: false, error: "Клуб не найден" };

  let candidates: ImportCandidate[];
  try {
    candidates = JSON.parse(String(formData.get("candidates") ?? "[]"));
  } catch {
    return { ok: false, error: "Не удалось прочитать данные для импорта" };
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, error: "Нет строк для импорта" };
  }

  // Existing rows for this club -> dedup keys.
  const [existingSales, existingExpenses] = await Promise.all([
    prisma.sale.findMany({
      where: { clubId },
      select: { source: true, amountKopeks: true, saleDate: true },
    }),
    prisma.expense.findMany({
      where: { clubId },
      select: { category: true, amountKopeks: true, expenseDate: true },
    }),
  ]);

  const seen = new Set<string>();
  for (const s of existingSales) {
    seen.add(dayKey(isoFromDate(s.saleDate), s.source, s.amountKopeks));
  }
  for (const e of existingExpenses) {
    seen.add(dayKey(isoFromDate(e.expenseDate), e.category, e.amountKopeks));
  }

  const salesToCreate: Array<{
    companyId: string;
    clubId: string;
    createdByUserId: string;
    source: string;
    amountKopeks: number;
    saleDate: Date;
  }> = [];
  const expensesToCreate: Array<{
    companyId: string;
    clubId: string;
    createdByUserId: string;
    category: string;
    amountKopeks: number;
    expenseDate: Date;
  }> = [];
  let skipped = 0;

  for (const c of candidates) {
    if (
      !c ||
      (c.kind !== "sale" && c.kind !== "expense") ||
      typeof c.label !== "string" ||
      typeof c.dateISO !== "string" ||
      typeof c.amountKopeks !== "number" ||
      !Number.isFinite(c.amountKopeks) ||
      c.amountKopeks <= 0
    ) {
      skipped += 1;
      continue;
    }

    const key = dayKey(c.dateISO, c.label, c.amountKopeks);
    if (seen.has(key)) {
      skipped += 1; // duplicate (already in DB or earlier in this batch)
      continue;
    }
    seen.add(key);

    const date = dateFromISO(c.dateISO);
    if (c.kind === "sale") {
      salesToCreate.push({
        companyId: club.companyId,
        clubId,
        createdByUserId: user.id,
        source: c.label,
        amountKopeks: c.amountKopeks,
        saleDate: date,
      });
    } else {
      expensesToCreate.push({
        companyId: club.companyId,
        clubId,
        createdByUserId: user.id,
        category: c.label,
        amountKopeks: c.amountKopeks,
        expenseDate: date,
      });
    }
  }

  await prisma.$transaction([
    prisma.sale.createMany({ data: salesToCreate }),
    prisma.expense.createMany({ data: expensesToCreate }),
  ]);

  revalidatePath("/sales");
  revalidatePath("/expenses");
  revalidatePath("/imports");

  return {
    ok: true,
    importedSales: salesToCreate.length,
    importedExpenses: expensesToCreate.length,
    skipped,
  };
}
