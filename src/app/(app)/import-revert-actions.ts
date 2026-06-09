"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canCreateOperational } from "@/lib/auth";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { revertImportBatchRows } from "@/lib/import-batches";

export type RevertState = { ok: boolean; error?: string; reverted?: number; kept?: number };

const REVALIDATE_PATHS: Record<string, string[]> = {
  expenses: ["/expenses", "/budgets", "/dashboard", "/analytics"],
  invoices: ["/invoices", "/dashboard", "/analytics"],
  sales_reports: ["/sales", "/dashboard", "/analytics"],
};

/**
 * Undo the last (or a specific) import batch. Soft-cancels only the rows created
 * by that batch; never touches records with downstream actions. Same permission
 * as importing (manager / regional, within scope).
 */
export async function revertImportBatch(
  _prev: RevertState | undefined,
  formData: FormData,
): Promise<RevertState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа" };
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return { ok: false, error: "Отменять импорт могут управляющие и региональные директора" };
  }

  const batchId = String(formData.get("batchId") ?? "").trim();
  if (!batchId) return { ok: false, error: "Не указан импорт" };

  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.companyId !== ctx.selectedCompanyId) {
    return { ok: false, error: "Импорт не найден" };
  }
  // Scope check: a club-scoped batch must be in the user's allowed clubs; a
  // company-wide (multi-club) batch can only be reverted by its creator.
  const inScope = batch.clubId
    ? ctx.allowedClubIds.includes(batch.clubId)
    : batch.createdByUserId === ctx.user.id;
  if (!inScope) return { ok: false, error: "Нет доступа к этому импорту" };

  if (batch.status !== "completed") {
    return { ok: false, error: "Этот импорт уже отменён" };
  }

  try {
    const { reverted, kept } = await revertImportBatchRows(batch.id, batch.type);
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: "reverted", revertedByUserId: ctx.user.id, revertedAt: new Date() },
    });
    await recordAudit({
      action: "import.reverted",
      entityType: "ImportBatch",
      entityId: batch.id,
      companyId: batch.companyId,
      clubId: batch.clubId,
      userId: ctx.user.id,
      metadata: { type: batch.type, fileName: batch.fileName, fileHash: batch.fileHash, reverted, kept },
    });
    for (const path of REVALIDATE_PATHS[batch.type] ?? []) revalidatePath(path);
    return { ok: true, reverted, kept };
  } catch (e) {
    await recordAudit({
      action: "import.revert_failed",
      entityType: "ImportBatch",
      entityId: batch.id,
      companyId: batch.companyId,
      clubId: batch.clubId,
      userId: ctx.user.id,
      metadata: { type: batch.type, error: e instanceof Error ? e.message : "unknown" },
    });
    return { ok: false, error: "Не удалось отменить импорт" };
  }
}
