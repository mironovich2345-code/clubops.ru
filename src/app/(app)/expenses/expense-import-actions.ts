"use server";

// Public Excel/CSV expense import has been removed from normal workflows.
//
// TODO(it-service-import): the row parser and import-batch machinery
// (src/lib/excel-import.ts, src/lib/import-batches.ts) are intentionally
// retained for a future service-import module wired ONLY to the platform IT
// Specialist contour. Do not re-expose this action to business roles.
import { type ImportActionState } from "@/lib/excel-import";
import { PUBLIC_IMPORT_DISABLED_MESSAGE, auditBlockedFeature } from "@/lib/disabled-features";

export async function importExpenses(): Promise<ImportActionState> {
  await auditBlockedFeature("import.expenses");
  return { ok: false, error: PUBLIC_IMPORT_DISABLED_MESSAGE };
}
