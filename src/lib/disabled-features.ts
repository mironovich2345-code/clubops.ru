// Pre-pilot product decision: monthly bulk operations, public Excel imports and
// structured business-data exports are disabled. This module centralizes the
// user-facing denial messages and a sanitized audit helper for blocked direct
// attempts, so a neutered server action can never execute the old behavior even
// if it is invoked directly (its button/page is gone, but the export remains).
import { getCurrentAccessContext, recordAudit } from "@/lib/access";

export const BULK_MONTHLY_DISABLED_MESSAGE = "Массовые операции за месяц отключены";
export const PUBLIC_IMPORT_DISABLED_MESSAGE = "Импорт доступен только через служебный контур";

/**
 * Records a sanitized audit event for a blocked attempt to call a disabled
 * feature directly. Best-effort and side-effect free: it never throws and logs
 * no payloads — the actual blocking is the action's early denial return.
 */
export async function auditBlockedFeature(feature: string): Promise<void> {
  try {
    const ctx = await getCurrentAccessContext();
    await recordAudit({
      action: "feature.blocked",
      entityType: "Feature",
      companyId: ctx?.selectedCompanyId ?? null,
      userId: ctx?.user.id ?? null,
      metadata: { feature },
    });
  } catch {
    // Best-effort only; the denial return below enforces the block regardless.
  }
}
