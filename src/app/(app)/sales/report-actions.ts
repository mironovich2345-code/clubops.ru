"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, canAccessClub, recordAudit } from "@/lib/access";
import {
  SALES_REPORT_ROWS,
  SALES_REPORT_ACTION_AUDIT,
  applySalesReportAction,
  canEditReport,
  getSalesReportForContext,
  type SalesReportAction,
} from "@/lib/sales-reports";
import { isUploadedFile, type UploadedFile } from "@/lib/uploaded-file";
import { validateReportFile, storeReportFile, MAX_REPORT_FILES } from "@/lib/sales-report-storage";

export type CreateReportState = {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<"clubId" | "reportDate", string>>;
};

function parseDateInput(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseAmount(raw: string): number {
  const n = Number(String(raw ?? "").trim().replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

export async function createSalesReport(
  _prev: CreateReportState | undefined,
  formData: FormData,
): Promise<CreateReportState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "sales")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return { ok: false, error: "Создавать отчёты могут управляющие и региональные директора" };
  }

  const clubId = String(formData.get("clubId") ?? "").trim();
  const reportDateRaw = String(formData.get("reportDate") ?? "").trim();
  const managerName = String(formData.get("managerName") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const fieldErrors: CreateReportState["fieldErrors"] = {};
  if (!clubId) fieldErrors.clubId = "Выберите клуб";
  const reportDate = parseDateInput(reportDateRaw);
  if (!reportDateRaw) fieldErrors.reportDate = "Укажите дату отчёта";
  else if (!reportDate) fieldErrors.reportDate = "Неверная дата";
  if (Object.keys(fieldErrors).length > 0) return { ok: false, error: "Проверьте поля формы", fieldErrors };

  if (!ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  if (!club || club.companyId !== ctx.selectedCompanyId) return { ok: false, error: "Клуб не найден" };

  const lines = SALES_REPORT_ROWS.map((row, i) => ({
    key: row.key,
    label: row.label,
    amountKopeks: rublesToKopeks(parseAmount(String(formData.get(`amount_${row.key}`) ?? ""))),
    sortOrder: i,
  }));

  const report = await prisma.salesReport.create({
    data: {
      companyId: club.companyId,
      clubId,
      reportDate: reportDate!,
      managerName,
      notes,
      createdByUserId: ctx.user.id,
      status: "pending_accountant",
      lines: { create: lines },
    },
  });

  await recordAudit({
    action: "sales_report.created",
    entityType: "SalesReport",
    entityId: report.id,
    companyId: club.companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { reportDate: reportDateRaw, totalRevenueKopeks: lines.find((l) => l.key === "total_revenue")?.amountKopeks ?? 0 },
  });

  revalidatePath("/sales");
  revalidatePath("/dashboard");
  redirect(`/sales/reports/${report.id}`);
}

export async function uploadSalesReportDocuments(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "sales")) throw new Error("Нет доступа");

  const reportId = String(formData.get("reportId") ?? "").trim();
  const report = await getSalesReportForContext(ctx, reportId);
  if (!report) throw new Error("Отчёт не найден или нет доступа");

  const isCreator = report.createdByUserId === ctx.user.id;
  if (!canEditReport(report.status, ctx.effectiveRoles, isCreator)) {
    throw new Error("Загружать документы можно только в свой отчёт на проверке");
  }

  const files = [] as UploadedFile[];
  for (const entry of formData.getAll("files")) {
    if (isUploadedFile(entry) && entry.size > 0) files.push(entry);
  }
  if (files.length === 0) throw new Error("Выберите файлы");
  if (report.documents.length + files.length > MAX_REPORT_FILES) {
    throw new Error(`Слишком много файлов (максимум ${MAX_REPORT_FILES})`);
  }

  let stored = 0;
  for (const file of files) {
    if (validateReportFile(file)) continue; // skip invalid; keep the rest
    const s = await storeReportFile(file);
    await prisma.salesReportDocument.create({
      data: {
        salesReportId: report.id,
        originalFileName: s.fileName,
        originalFileMime: s.mime,
        originalFileSize: s.size,
        storageKey: s.storageKey,
        uploadedByUserId: ctx.user.id,
      },
    });
    stored++;
  }
  if (stored === 0) throw new Error("Файлы не загружены: проверьте формат и размер");

  await recordAudit({
    action: "sales_report.document_uploaded",
    entityType: "SalesReport",
    entityId: report.id,
    companyId: report.companyId,
    clubId: report.clubId,
    userId: ctx.user.id,
    metadata: { count: stored },
  });

  revalidatePath(`/sales/reports/${report.id}`);
}

export async function transitionSalesReport(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "sales")) throw new Error("Нет доступа");

  const reportId = String(formData.get("reportId") ?? "").trim();
  const action = String(formData.get("action") ?? "").trim() as SalesReportAction;
  if (!(action in SALES_REPORT_ACTION_AUDIT)) throw new Error("Неверное действие");

  const report = await getSalesReportForContext(ctx, reportId);
  if (!report) throw new Error("Отчёт не найден или нет доступа");

  const isCreator = report.createdByUserId === ctx.user.id;
  const result = applySalesReportAction(action, report.status, ctx.effectiveRoles, isCreator);
  if (!result.ok) throw new Error(result.error);

  const reason = String(formData.get("rejectionReason") ?? "").trim() || null;
  const now = new Date();

  await prisma.salesReport.update({
    where: { id: report.id },
    data: {
      status: result.to,
      ...(result.to === "confirmed" ? { verifiedByUserId: ctx.user.id, verifiedAt: now } : {}),
      ...(result.to === "rejected" ? { rejectedByUserId: ctx.user.id, rejectedAt: now, rejectionReason: reason } : {}),
    },
  });

  await recordAudit({
    action: SALES_REPORT_ACTION_AUDIT[action],
    entityType: "SalesReport",
    entityId: report.id,
    companyId: report.companyId,
    clubId: report.clubId,
    userId: ctx.user.id,
    metadata: { from: report.status, to: result.to, ...(reason ? { reason } : {}) },
  });

  revalidatePath("/sales");
  revalidatePath(`/sales/reports/${report.id}`);
  revalidatePath("/dashboard");
}
