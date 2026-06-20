"use server";

// Public Excel/CSV sales-plan import has been removed from normal workflows.
// Plans are entered via the manual plan form; the read-only plans table remains.
//
// TODO(it-service-import): a service-import module may later be wired ONLY to
// the platform IT Specialist contour. Do not re-expose this action to business
// roles. The xlsx parser stays available for that future module.
import { PUBLIC_IMPORT_DISABLED_MESSAGE, auditBlockedFeature } from "@/lib/disabled-features";

export type ImportError = { row: number; club: string; issue: string };
export type ImportResult = {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportError[];
};
export type ImportState = { ok: boolean; error?: string; result?: ImportResult };

export async function importSalesPlans(): Promise<ImportState> {
  await auditBlockedFeature("import.sales_plans");
  return { ok: false, error: PUBLIC_IMPORT_DISABLED_MESSAGE };
}
