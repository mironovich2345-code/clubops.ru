"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, canAccessClub, recordAudit } from "@/lib/access";
import { validateExpenseFile, persistExpenseFile } from "@/lib/expense-storage";
import { isUploadedFile } from "@/lib/uploaded-file";
import { UPLOAD_ERROR_MESSAGES, logUploadFailure, type UploadErrorCode } from "@/lib/upload-errors";
import {
  analyzePayrollDocument,
  manualPayrollExtraction,
  type Confidence,
} from "@/lib/ai/payroll-analyzer";
import {
  payrollRowHash,
  PAYROLL_EXPENSE_NOTE,
  PAYROLL_MESSAGE_NO_NEW_ROWS,
} from "@/lib/payroll";

export type PayrollRowView = {
  employeeName: string | null;
  role: string | null;
  amount: number | null; // rubles
  isSigned: boolean;
  signatureConfidence: Confidence;
};

type AnalyzeState = {
  ok: boolean;
  errorCode?: UploadErrorCode;
  clubId?: string;
  storageKey?: string;
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  period?: string | null;
  rows?: PayrollRowView[];
  blocked?: boolean;
  mode?: "ai" | "mock";
  warnings?: string[];
  rawJson?: string;
};

type SaveState = {
  ok: boolean;
  error?: string;
  message?: string;
  statementId?: string;
  totalSignedKopeks?: number;
  newSignedKopeks?: number;
  skippedRows?: number;
  expenseCreated?: boolean;
};

function str(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? "").trim();
  return v || null;
}

async function clubCompanyId(clubId: string): Promise<string | null> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  return club?.companyId ?? null;
}

export async function uploadAndAnalyzePayroll(
  _prev: AnalyzeState | undefined,
  formData: FormData,
): Promise<AnalyzeState> {
  let ctx: Awaited<ReturnType<typeof getCurrentAccessContext>> = null;
  const clubId = String(formData.get("clubId") ?? "").trim();
  const fileEntry = formData.get("file");
  const file = isUploadedFile(fileEntry) && fileEntry.size > 0 ? fileEntry : null;

  function fail(code: UploadErrorCode, message = ""): AnalyzeState {
    logUploadFailure("payroll", {
      code,
      message,
      userId: ctx?.user.id ?? null,
      companyId: ctx?.selectedCompanyId ?? null,
      clubId: clubId || null,
      fileName: file?.name ?? null,
      fileMime: file?.type ?? null,
      fileSize: file?.size ?? null,
    });
    return { ok: false, errorCode: code, clubId: clubId || undefined };
  }

  try {
    ctx = await getCurrentAccessContext();
    if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) return fail("ACCESS_DENIED");
    if (!clubId) return fail("CLUB_REQUIRED");
    if (!ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
      return fail("ACCESS_DENIED");
    }

    if (!file) {
      // Manual entry (no file): start with an empty editable rows table.
      const manual = manualPayrollExtraction();
      return { ok: true, clubId, rows: [], period: null, blocked: false, mode: "mock", warnings: manual.warnings };
    }

    const fileCode = validateExpenseFile(file);
    if (fileCode) return fail(fileCode);

    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch (readError) {
      return fail("FILE_READ_FAILED", readError instanceof Error ? readError.message : "read failed");
    }

    let storageKey: string | undefined;
    let size = file.size;
    let storageFailed = false;
    try {
      const stored = await persistExpenseFile(buffer, file.type, file.name);
      storageKey = stored.storageKey;
      size = stored.size;
    } catch (storeError) {
      storageFailed = true;
      logUploadFailure("payroll", {
        code: "STORAGE_FAILED",
        message: storeError instanceof Error ? storeError.message : "store failed",
        userId: ctx.user.id,
        companyId: ctx.selectedCompanyId,
        clubId,
        fileName: file.name,
        fileMime: file.type,
        fileSize: file.size,
      });
    }

    const extraction = await analyzePayrollDocument({ buffer, mime: file.type, fileName: file.name });
    const warnings = storageFailed
      ? [UPLOAD_ERROR_MESSAGES.STORAGE_FAILED, ...extraction.warnings]
      : extraction.warnings;

    try {
      await recordAudit({
        action: "payroll_statement.uploaded",
        entityType: "PayrollStatement",
        companyId: ctx.selectedCompanyId,
        clubId,
        userId: ctx.user.id,
        metadata: { fileName: file.name, mime: file.type, size },
      });
      await recordAudit({
        action: "payroll_statement.extracted",
        entityType: "PayrollStatement",
        companyId: ctx.selectedCompanyId,
        clubId,
        userId: ctx.user.id,
        metadata: { rows: extraction.rows.length, mode: extraction.mode, blocked: extraction.blocked },
      });
    } catch (auditError) {
      console.error("payroll audit failed", auditError instanceof Error ? auditError.message : auditError);
    }

    return {
      ok: true,
      clubId,
      storageKey,
      fileName: file.name,
      fileMime: file.type,
      fileSize: size,
      period: extraction.period,
      rows: extraction.rows.map((r) => ({
        employeeName: r.employeeName,
        role: r.role,
        amount: r.amount,
        isSigned: r.isSigned,
        signatureConfidence: r.signatureConfidence,
      })),
      blocked: extraction.blocked,
      mode: extraction.mode,
      warnings,
      rawJson: extraction.rawTextOrModelOutput,
    };
  } catch (error) {
    return fail("UNKNOWN_ERROR", error instanceof Error ? error.message : "unknown");
  }
}

type RowInput = {
  employeeName: string | null;
  role: string | null;
  amountKopeks: number;
  isSigned: boolean;
  signatureConfidence: Confidence;
};

function parseRows(formData: FormData): RowInput[] {
  let arr: unknown;
  try {
    arr = JSON.parse(String(formData.get("rowsJson") ?? "[]"));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const name = typeof r.employeeName === "string" && r.employeeName.trim() ? r.employeeName.trim() : null;
    const role = typeof r.role === "string" && r.role.trim() ? r.role.trim() : null;
    const amountRaw = typeof r.amount === "number" ? r.amount : Number(String(r.amount ?? "").replace(",", "."));
    const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : 0;
    const conf = r.signatureConfidence;
    return {
      employeeName: name,
      role,
      amountKopeks: rublesToKopeks(amount),
      isSigned: r.isSigned === true || r.isSigned === "true",
      signatureConfidence: conf === "high" || conf === "medium" || conf === "low" ? conf : "low",
    };
  });
}

export async function savePayrollStatement(
  _prev: SaveState | undefined,
  formData: FormData,
): Promise<SaveState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) {
    return { ok: false, error: "Нет доступа" };
  }

  const clubId = String(formData.get("clubId") ?? "").trim();
  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }
  const companyId = await clubCompanyId(clubId);
  if (!companyId || companyId !== ctx.selectedCompanyId) {
    return { ok: false, error: "Клуб не найден" };
  }

  const period = str(formData, "period");
  const rows = parseRows(formData);
  if (rows.length === 0) {
    return { ok: false, error: "Добавьте хотя бы одну строку ведомости" };
  }

  const userId = ctx.user.id;
  const now = new Date();

  // Process in a transaction so dedup + expense creation are atomic.
  const result = await prisma.$transaction(async (tx) => {
    const statement = await tx.payrollStatement.create({
      data: {
        companyId,
        clubId,
        createdByUserId: userId,
        period,
        status: "confirmed",
        originalFileName: str(formData, "fileName"),
        originalFileMime: str(formData, "fileMime"),
        originalFileSize: Number(formData.get("fileSize")) || null,
        originalFileStorageKey: str(formData, "storageKey"),
        rawExtractedJson: str(formData, "rawJson"),
      },
    });

    let totalSignedKopeks = 0;
    let newSignedKopeks = 0;
    let skippedRows = 0;

    for (const row of rows) {
      const rowHash = payrollRowHash({
        employeeName: row.employeeName,
        role: row.role,
        amountKopeks: row.amountKopeks,
        period,
      });
      const existing = await tx.payrollStatementRow.findUnique({
        where: { companyId_clubId_rowHash: { companyId, clubId, rowHash } },
      });

      if (row.isSigned && row.amountKopeks > 0) {
        totalSignedKopeks += row.amountKopeks;
        if (existing && existing.countedAt) {
          // Already counted on a previous upload — never count twice.
          skippedRows += 1;
          continue;
        }
        newSignedKopeks += row.amountKopeks;
        await tx.payrollStatementRow.upsert({
          where: { companyId_clubId_rowHash: { companyId, clubId, rowHash } },
          create: {
            payrollStatementId: statement.id,
            companyId,
            clubId,
            employeeName: row.employeeName,
            role: row.role,
            amountKopeks: row.amountKopeks,
            isSigned: true,
            signatureDetectedConfidence: row.signatureConfidence,
            rowHash,
            countedAt: now,
          },
          update: {
            isSigned: true,
            signatureDetectedConfidence: row.signatureConfidence,
            countedAt: now,
            employeeName: row.employeeName,
            role: row.role,
          },
        });
      } else {
        // Unsigned row: record for future signing, but do not count. Never
        // overwrite a row that was already counted.
        if (!existing) {
          await tx.payrollStatementRow.create({
            data: {
              payrollStatementId: statement.id,
              companyId,
              clubId,
              employeeName: row.employeeName,
              role: row.role,
              amountKopeks: row.amountKopeks,
              isSigned: false,
              signatureDetectedConfidence: row.signatureConfidence,
              rowHash,
              countedAt: null,
            },
          });
        }
      }
    }

    await tx.payrollStatement.update({
      where: { id: statement.id },
      data: { totalSignedAmountKopeks: totalSignedKopeks, newSignedAmountKopeks: newSignedKopeks },
    });

    let expenseId: string | null = null;
    if (newSignedKopeks > 0) {
      const expense = await tx.expense.create({
        data: {
          companyId,
          clubId,
          createdByUserId: userId,
          type: "payroll_statement",
          category: "salary",
          amountKopeks: newSignedKopeks,
          currency: "RUB",
          expenseDate: now,
          status: "confirmed",
          confidence: "high",
          notes: PAYROLL_EXPENSE_NOTE,
          originalFileName: str(formData, "fileName"),
          originalFileMime: str(formData, "fileMime"),
          originalFileSize: Number(formData.get("fileSize")) || null,
          originalFileStorageKey: str(formData, "storageKey"),
        },
      });
      expenseId = expense.id;
    }

    return { statementId: statement.id, totalSignedKopeks, newSignedKopeks, skippedRows, expenseId };
  });

  // Audits after the transaction commits.
  try {
    await recordAudit({
      action: "payroll_statement.created",
      entityType: "PayrollStatement",
      entityId: result.statementId,
      companyId,
      clubId,
      userId,
      metadata: {
        totalSignedKopeks: result.totalSignedKopeks,
        newSignedKopeks: result.newSignedKopeks,
        period,
      },
    });
    if (result.skippedRows > 0) {
      await recordAudit({
        action: "payroll_statement.duplicate_rows_skipped",
        entityType: "PayrollStatement",
        entityId: result.statementId,
        companyId,
        clubId,
        userId,
        metadata: { skippedRows: result.skippedRows },
      });
    }
    if (result.expenseId) {
      await recordAudit({
        action: "expense.created",
        entityType: "Expense",
        entityId: result.expenseId,
        companyId,
        clubId,
        userId,
        metadata: { type: "payroll_statement", amountKopeks: result.newSignedKopeks },
      });
    }
  } catch (auditError) {
    console.error("payroll save audit failed", auditError instanceof Error ? auditError.message : auditError);
  }

  revalidatePath("/expenses");

  return {
    ok: true,
    statementId: result.statementId,
    totalSignedKopeks: result.totalSignedKopeks,
    newSignedKopeks: result.newSignedKopeks,
    skippedRows: result.skippedRows,
    expenseCreated: Boolean(result.expenseId),
    message: result.newSignedKopeks > 0 ? undefined : PAYROLL_MESSAGE_NO_NEW_ROWS,
  };
}
