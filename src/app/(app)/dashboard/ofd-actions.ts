"use server";

import { revalidatePath } from "next/cache";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { can } from "@/lib/auth";
import { isRateLimited } from "@/lib/rate-limit";
import { ofdEnabled } from "@/lib/ofd/config";
import { runSyncNowForCompany } from "@/lib/ofd/daily";

export type DashboardSyncState = {
  ok: boolean;
  error?: string;
  notice?: string;
  sync?: { found: number; imported: number; skipped: number };
};

/**
 * Manual OFD sync from the dashboard. Reuses the SAME sync service as the settings page
 * (`runSyncNowForCompany`) — no second sync mechanism. Blocked by (a) the shared
 * per-company rate limit (also blocks double-clicks / duplicate same-period import) and
 * (b) the importer's per-connection concurrency lock. Server-side capability + company
 * scope; a user can never sync another company (companyId comes from their own context).
 */
export async function triggerOfdSync(
  _prev: DashboardSyncState | undefined,
  _formData: FormData,
): Promise<DashboardSyncState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа." };
  if (!ofdEnabled()) return { ok: false, error: "Интеграции ОФД сейчас отключены." };
  if (!can(ctx.effectiveRoles, "ofd.sync.trigger")) return { ok: false, error: "Недостаточно прав для запуска синхронизации." };
  const companyId = ctx.selectedCompanyId;

  if (await isRateLimited("ofd_sync_now", "company", companyId)) {
    return { ok: false, error: "Синхронизация запускалась недавно. Повторите через несколько минут." };
  }

  const result = await runSyncNowForCompany(companyId);
  try {
    await recordAudit({
      action: "ofd.sync_now",
      entityType: "OfdConnection",
      companyId,
      userId: ctx.user.id,
      metadata: {
        source: "dashboard",
        date: result.date,
        processedConnections: result.processedConnections,
        succeeded: result.succeeded,
        failed: result.failed,
        found: result.totals.foundReceipts,
        imported: result.totals.importedReceipts,
        skipped: result.totals.skippedReceipts,
      },
    });
  } catch {
    /* audit must never block */
  }

  revalidatePath("/dashboard");
  revalidatePath("/analytics/ofd-sales");
  revalidatePath("/collections");

  if (result.processedConnections === 0) {
    return { ok: true, notice: "Нет активных подключений ОФД." };
  }
  const t = result.totals;
  return {
    ok: true,
    notice: `Готово: найдено ${t.foundReceipts}, добавлено ${t.importedReceipts}, пропущено ${t.skippedReceipts}.`,
    sync: { found: t.foundReceipts, imported: t.importedReceipts, skipped: t.skippedReceipts },
  };
}
