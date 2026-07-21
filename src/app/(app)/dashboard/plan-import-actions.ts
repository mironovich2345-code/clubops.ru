"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { canImportPlansAndBudgets } from "@/lib/auth";
import { normalizeMonth } from "@/lib/sales-plans";
import { isUploadedFile } from "@/lib/uploaded-file";
import { PUBLIC_IMPORT_DISABLED_MESSAGE, auditBlockedFeature } from "@/lib/disabled-features";
import { parsePlanSheet, buildPlanPreview, type PlanPreviewRow } from "@/lib/imports/plan-import";
import { WorkbookLimitError } from "@/lib/excel-import";

// The old public bulk import stays disabled; the owner/GD template import below is
// the supported flow (download template → upload → preview → confirm).
export type ImportState = { ok: boolean; error?: string };
export async function importSalesPlans(): Promise<ImportState> {
  await auditBlockedFeature("import.sales_plans");
  return { ok: false, error: PUBLIC_IMPORT_DISABLED_MESSAGE };
}

export type PlanImportState = {
  ok: boolean;
  error?: string;
  month?: string;
  preview?: PlanPreviewRow[];
  anyError?: boolean;
  applied?: { created: number; updated: number };
};

async function scopeClubs(companyId: string, clubIds: string[]) {
  if (clubIds.length === 0) return [];
  const clubs = await prisma.club.findMany({ where: { companyId, id: { in: clubIds } }, select: { id: true, name: true, city: true } });
  return clubs.map((c) => ({ id: c.id, name: c.name, city: c.city ?? "" }));
}

/** Owner/GD: parse an uploaded plan file and return a preview (no writes). */
export async function previewPlanImport(_prev: PlanImportState | undefined, formData: FormData): Promise<PlanImportState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа." };
  if (!canImportPlansAndBudgets(ctx.effectiveRoles)) return { ok: false, error: "Импорт планов доступен только владельцу или ген. директору." };
  const month = normalizeMonth(String(formData.get("month") ?? ""));
  if (!month) return { ok: false, error: "Укажите месяц." };
  const file = formData.get("file");
  if (!isUploadedFile(file)) return { ok: false, error: "Прикрепите файл шаблона (XLSX/CSV)." };
  const buffer = Buffer.from(await file.arrayBuffer());

  let raw: ReturnType<typeof parsePlanSheet>["rows"];
  let missing: string[];
  try {
    ({ rows: raw, missing } = parsePlanSheet(buffer));
  } catch (e) {
    return { ok: false, error: e instanceof WorkbookLimitError ? e.message : "Не удалось прочитать файл.", month };
  }
  if (missing.length) return { ok: false, error: `В файле нет колонок: ${missing.join(", ")}.`, month };
  if (raw.length === 0) return { ok: false, error: "В файле нет строк с данными.", month };

  const clubs = await scopeClubs(ctx.selectedCompanyId, ctx.allowedClubIds);
  const plans = await prisma.salesPlan.findMany({ where: { companyId: ctx.selectedCompanyId, month, clubId: { in: clubs.map((c) => c.id) } }, select: { clubId: true, planType: true, targetAmountKopeks: true } });
  const cur = new Map<string, { clubId: string; subsKopeks: number; ptKopeks: number }>();
  for (const p of plans) {
    if (!p.clubId) continue;
    const e = cur.get(p.clubId) ?? { clubId: p.clubId, subsKopeks: 0, ptKopeks: 0 };
    if (p.planType === "subscriptions") e.subsKopeks = p.targetAmountKopeks;
    if (p.planType === "personal_training") e.ptKopeks = p.targetAmountKopeks;
    cur.set(p.clubId, e);
  }
  const { rows, anyError } = buildPlanPreview({ rawRows: raw, scopeClubs: clubs, currentPlans: [...cur.values()], month });
  return { ok: true, month, preview: rows, anyError };
}

/** Owner/GD: apply confirmed plan rows. ATOMIC — re-validates scope, then writes
 * subscriptions / personal_training / total(=sum) per club in a transaction. */
export async function applyPlanImport(_prev: PlanImportState | undefined, formData: FormData): Promise<PlanImportState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа." };
  if (!canImportPlansAndBudgets(ctx.effectiveRoles)) return { ok: false, error: "Импорт планов доступен только владельцу или ген. директору." };
  const companyId = ctx.selectedCompanyId;
  const month = normalizeMonth(String(formData.get("month") ?? ""));
  if (!month) return { ok: false, error: "Укажите месяц." };

  let payload: { clubId: string; subsKopeks: number; ptKopeks: number }[];
  try {
    const parsed = JSON.parse(String(formData.get("payload") ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error("bad");
    payload = parsed;
  } catch {
    return { ok: false, error: "Не удалось прочитать данные для импорта." };
  }
  if (payload.length === 0) return { ok: false, error: "Нет строк для применения." };

  const allowed = new Set(ctx.allowedClubIds);
  for (const r of payload) {
    if (!r || typeof r.clubId !== "string" || !allowed.has(r.clubId)) return { ok: false, error: "Клуб вне вашего доступа." };
    if (!Number.isInteger(r.subsKopeks) || !Number.isInteger(r.ptKopeks) || r.subsKopeks < 0 || r.ptKopeks < 0) return { ok: false, error: "Некорректные суммы." };
  }
  const validClubIds = new Set((await prisma.club.findMany({ where: { companyId, id: { in: payload.map((r) => r.clubId) } }, select: { id: true } })).map((c) => c.id));
  for (const r of payload) if (!validClubIds.has(r.clubId)) return { ok: false, error: "Клуб не найден в компании." };

  let created = 0;
  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of payload) {
      for (const [planType, amt] of [["subscriptions", r.subsKopeks], ["personal_training", r.ptKopeks], ["total", r.subsKopeks + r.ptKopeks]] as const) {
        const existing = await tx.salesPlan.findFirst({ where: { companyId, clubId: r.clubId, month, planType }, select: { id: true } });
        if (existing) {
          await tx.salesPlan.update({ where: { id: existing.id }, data: { targetAmountKopeks: amt } });
          updated += 1;
        } else {
          await tx.salesPlan.create({ data: { companyId, clubId: r.clubId, month, planType, targetAmountKopeks: amt, createdByUserId: ctx.user.id } });
          created += 1;
        }
      }
    }
  });
  await recordAudit({ action: "sales_plan.imported", entityType: "SalesPlan", companyId, userId: ctx.user.id, metadata: { month, clubs: payload.length, created, updated } });
  revalidatePath("/dashboard");
  revalidatePath("/analytics");
  return { ok: true, month, applied: { created, updated } };
}
