// Pure helpers for Taxcom договор (contract) diagnostics. Kept OUT of the
// "use server" actions module so non-async exports are allowed, and importable
// by client components (type-only) without pulling in server code.

/** SAFE Taxcom check-connection diagnostics — never carries login / password /
 * Integrator-ID / SessionToken or the raw AccountList; only the договор fields
 * shown to the admin so they can pick the right ЛК. */
export type OfdCheckDiagnostics = {
  currentSession: string | null;
  requestedContractNumber: string;
  availableContracts: { agreementNumber: string | null; companyName: string | null; inn: string | null; kpp: string | null }[];
};

/** Normalize a Taxcom договор number for comparison: strip all whitespace
 * (incl. non-breaking / narrow / BOM), fold every unicode dash/minus to "-",
 * and compare case-insensitively. "CD-25/45507", "CD‑25/45507" (NB-hyphen),
 * "CD–25/45507" (en-dash) and " cd-25/45507 " all normalize equal. */
export function normalizeContractNumber(v: string | null | undefined): string {
  return (v ?? "")
    .replace(/[‐-―−－]/g, "-") // hyphen/dash/minus/fullwidth → "-"
    .replace(/[\s  ﻿]/g, "") // all whitespace incl. NBSP / narrow NBSP / BOM
    .toLowerCase();
}
