"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, canAccessClub, recordAudit } from "@/lib/access";
import {
  SALES_REPORT_ROWS,
  SALES_REPORT_ROW_LABELS,
  BASE_ROWS,
  REVENUE_LINE_KEY,
  REVENUE_OOO_KEY,
  SUBSCRIPTIONS_OOO_KEY,
  PERSONAL_TRAINING_OOO_KEY,
  SALES_REPORT_DOC_TYPE_KEYS,
  computeSalesReportTotals,
  validateSalesReportForConfirmation,
  SALES_REPORT_ACTION_AUDIT,
  applySalesReportAction,
  canEditReport,
  canUnconfirmReport,
  getSalesReportForContext,
  type SalesReportAction,
} from "@/lib/sales-reports";
import { getClubEntityByType } from "@/lib/legal-entities";
import { SHIFT_MANAGER_POSITIONS } from "@/lib/club-employees";
import { monthClosedError } from "@/lib/month-close";
import { isUploadedFile, type UploadedFile } from "@/lib/uploaded-file";
import { validateReportFile, storeReportFile, MAX_REPORT_FILES } from "@/lib/sales-report-storage";
import { auditBlockedFeature, MANUAL_SALES_DISABLED_MESSAGE } from "@/lib/disabled-features";

export type CreateReportState = {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<"clubId" | "reportDate", string>>;
  /** Set when a duplicate active report already exists — links to it. */
  existingReportId?: string;
};

// A report still counts toward revenue / blocks duplicates while active.
const ACTIVE_REPORT_STATUSES = ["pending_accountant", "confirmed"];

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
  // Manual shift-report entry is retired — sales come from ОФД. Even a direct POST
  // is refused here, so no NEW report can be created. Existing reports stay
  // read-only (transition/upload actions are untouched). No hard delete.
  await auditBlockedFeature("sales_report.create");
  return { ok: false, error: MANUAL_SALES_DISABLED_MESSAGE };
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
  const closedDoc = await monthClosedError(report.companyId, report.clubId, report.reportDate);
  if (closedDoc) throw new Error(closedDoc);

  const docTypeRaw = String(formData.get("docType") ?? "other");
  const docType = SALES_REPORT_DOC_TYPE_KEYS.includes(docTypeRaw) ? docTypeRaw : "other";

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
        type: docType,
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
    action: docType === "encashment" ? "sales_report.encashment_document_uploaded" : "sales_report.document_uploaded",
    entityType: "SalesReport",
    entityId: report.id,
    companyId: report.companyId,
    clubId: report.clubId,
    userId: ctx.user.id,
    metadata: { count: stored, type: docType },
  });

  revalidatePath(`/sales/reports/${report.id}`);
}

// Per-type audit action for an uploaded supporting document.
const DOC_UPLOAD_AUDIT: Record<string, string> = {
  ooo_report: "sales_report.ooo_report_uploaded",
  ip_report: "sales_report.ip_report_uploaded",
  encashment: "sales_report.encashment_document_uploaded",
  withdrawal: "sales_report.withdrawal_document_uploaded",
};
const DEFAULT_DOC_AUDIT = "sales_report.document_uploaded";

/**
 * Structured multi-slot upload: one labeled file input per document type
 * (file_ooo_report, file_ip_report, file_encashment, file_withdrawal,
 * file_other, ...). Stores every provided file under its type and emits a
 * per-type audit event. Same edit-permission rules as the single-type upload.
 */
export async function uploadSalesReportDocSlots(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "sales")) throw new Error("Нет доступа");

  const reportId = String(formData.get("reportId") ?? "").trim();
  const report = await getSalesReportForContext(ctx, reportId);
  if (!report) throw new Error("Отчёт не найден или нет доступа");

  const isCreator = report.createdByUserId === ctx.user.id;
  if (!canEditReport(report.status, ctx.effectiveRoles, isCreator)) {
    throw new Error("Загружать документы можно только в свой отчёт на проверке");
  }
  const closedSlots = await monthClosedError(report.companyId, report.clubId, report.reportDate);
  if (closedSlots) throw new Error(closedSlots);

  // Gather files per slot (typed by the input name suffix).
  const slots: Array<{ type: string; files: UploadedFile[] }> = [];
  let totalIncoming = 0;
  for (const type of SALES_REPORT_DOC_TYPE_KEYS) {
    const files: UploadedFile[] = [];
    for (const entry of formData.getAll(`file_${type}`)) {
      if (isUploadedFile(entry) && entry.size > 0) files.push(entry);
    }
    if (files.length > 0) {
      slots.push({ type, files });
      totalIncoming += files.length;
    }
  }
  if (totalIncoming === 0) throw new Error("Выберите хотя бы один файл");
  if (report.documents.length + totalIncoming > MAX_REPORT_FILES) {
    throw new Error(`Слишком много файлов (максимум ${MAX_REPORT_FILES})`);
  }

  let storedTotal = 0;
  for (const slot of slots) {
    let stored = 0;
    for (const file of slot.files) {
      if (validateReportFile(file)) continue; // skip invalid; keep the rest
      const s = await storeReportFile(file);
      await prisma.salesReportDocument.create({
        data: {
          salesReportId: report.id,
          type: slot.type,
          originalFileName: s.fileName,
          originalFileMime: s.mime,
          originalFileSize: s.size,
          storageKey: s.storageKey,
          uploadedByUserId: ctx.user.id,
        },
      });
      stored++;
    }
    if (stored > 0) {
      storedTotal += stored;
      await recordAudit({
        action: DOC_UPLOAD_AUDIT[slot.type] ?? DEFAULT_DOC_AUDIT,
        entityType: "SalesReport",
        entityId: report.id,
        companyId: report.companyId,
        clubId: report.clubId,
        userId: ctx.user.id,
        metadata: { count: stored, type: slot.type },
      });
    }
  }
  if (storedTotal === 0) throw new Error("Файлы не загружены: проверьте формат и размер");

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

  const closedTransition = await monthClosedError(report.companyId, report.clubId, report.reportDate);
  if (closedTransition) throw new Error(closedTransition);

  const isCreator = report.createdByUserId === ctx.user.id;
  const result = applySalesReportAction(action, report.status, ctx.effectiveRoles, isCreator);
  if (!result.ok) throw new Error(result.error);

  const reason = String(formData.get("rejectionReason") ?? "").trim() || null;
  const comment = String(formData.get("accountantComment") ?? "").trim() || null;
  // Rejection requires a reason; confirmation comment is optional.
  if (result.to === "rejected" && !reason) throw new Error("Укажите причину отклонения");

  // Part 5/6 — confirmation is blocked until the report passes validation
  // (ООО balance + required КМ-6 / encashment / withdrawal documents).
  if (result.to === "confirmed") {
    // Manager smeny must be present. Legacy reports created before the employee
    // selector keep a managerName string and still pass; only a report with no
    // manager at all is blocked.
    if (!report.managerEmployeeId && !report.managerName) {
      throw new Error("Выберите менеджера смены");
    }
    const check = validateSalesReportForConfirmation({
      lines: report.lines.map((l) => ({ key: l.key, amountKopeks: l.amountKopeks })),
      documentTypes: report.documents.map((d) => d.type),
    });
    if (check.blockingErrors.length > 0) {
      await recordAudit({
        action: "sales_report.confirm_blocked",
        entityType: "SalesReport",
        entityId: report.id,
        companyId: report.companyId,
        clubId: report.clubId,
        userId: ctx.user.id,
        metadata: { errors: check.blockingErrors },
      });
      throw new Error(check.blockingErrors.join("; "));
    }
  }
  const now = new Date();

  await prisma.salesReport.update({
    where: { id: report.id },
    data: {
      status: result.to,
      ...(result.to === "confirmed" ? { verifiedByUserId: ctx.user.id, verifiedAt: now, accountantComment: comment } : {}),
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
    metadata: { from: report.status, to: result.to, ...(reason ? { reason } : {}), ...(comment ? { comment } : {}) },
  });

  // Separate audit event when an accountant leaves a comment on confirmation.
  if (result.to === "confirmed" && comment) {
    await recordAudit({
      action: "sales_report.comment_added",
      entityType: "SalesReport",
      entityId: report.id,
      companyId: report.companyId,
      clubId: report.clubId,
      userId: ctx.user.id,
      metadata: { comment },
    });
  }

  revalidatePath("/sales");
  revalidatePath(`/sales/reports/${report.id}`);
  revalidatePath("/dashboard");
}

/**
 * Part 1 — undo a confirmation. Returns a confirmed report to pending_accountant
 * (so it stops counting in dashboard/analytics) and clears the verification stamp.
 * Accountant or owner only; reason required; blocked in a closed month. Documents
 * and report lines are preserved.
 */
export async function unconfirmSalesReport(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "sales")) throw new Error("Нет доступа");
  if (!canUnconfirmReport(ctx.effectiveRoles)) throw new Error("Отменить подтверждение может бухгалтер или владелец");

  const reportId = String(formData.get("reportId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) throw new Error("Укажите причину отмены подтверждения");

  const report = await getSalesReportForContext(ctx, reportId);
  if (!report) throw new Error("Отчёт не найден или нет доступа");
  if (report.status !== "confirmed") throw new Error("Отменить подтверждение можно только у подтверждённого отчёта");

  const closed = await monthClosedError(report.companyId, report.clubId, report.reportDate);
  if (closed) throw new Error(closed);

  await prisma.salesReport.update({
    where: { id: report.id },
    // Lines + documents are untouched; only the verification stamp is cleared.
    data: { status: "pending_accountant", verifiedByUserId: null, verifiedAt: null, accountantComment: null },
  });

  await recordAudit({
    action: "sales_report.unconfirmed",
    entityType: "SalesReport",
    entityId: report.id,
    companyId: report.companyId,
    clubId: report.clubId,
    userId: ctx.user.id,
    metadata: { from: "confirmed", to: "pending_accountant", reason },
  });

  revalidatePath("/sales");
  revalidatePath(`/sales/reports/${report.id}`);
  revalidatePath("/dashboard");
}
