"use server";

// Public import revert/undo has been removed along with public Excel imports.
//
// TODO(it-service-import): import batches (ImportBatch) and the row-revert
// machinery (src/lib/import-batches.ts) are intentionally retained for the
// future IT Specialist service-import contour. Existing ImportBatch history is
// preserved; this public action only denies direct calls.
import { PUBLIC_IMPORT_DISABLED_MESSAGE, auditBlockedFeature } from "@/lib/disabled-features";

export type RevertState = { ok: boolean; error?: string; reverted?: number; kept?: number };

export async function revertImportBatch(): Promise<RevertState> {
  await auditBlockedFeature("import.revert");
  return { ok: false, error: PUBLIC_IMPORT_DISABLED_MESSAGE };
}
