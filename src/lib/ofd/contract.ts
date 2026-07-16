// Pure helpers for Taxcom договор (contract) diagnostics. Kept OUT of the
// "use server" actions module so non-async exports are allowed, and importable
// by client components (type-only) without pulling in server code.

/** One договор/ЛК reduced to the SAFE fields shown in the UI — no secrets,
 * no accessRights, no raw AccountList payload. */
export type OfdSafeContract = {
  agreementNumber: string | null;
  companyName: string | null;
  inn: string | null;
  kpp: string | null;
};

/** SAFE Taxcom check-connection diagnostics — never carries login / password /
 * Integrator-ID / SessionToken or the raw AccountList; only the договор fields
 * shown to the admin so they can pick the right ЛК. */
export type OfdCheckDiagnostics = {
  currentSession: string | null;
  requestedContractNumber: string;
  availableContracts: OfdSafeContract[];
  matchedContract?: OfdSafeContract | null;
};

// Cyrillic letters that are visually identical to Latin ones. A договор number
// pasted from a Russian portal (e.g. "СD-25/45507" with a Cyrillic С) otherwise
// fails a byte comparison against the Latin code Такском returns, even though the
// two look identical on screen — which is exactly the production "not found" bug.
const HOMOGLYPHS: Record<string, string> = {
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M",
  "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T",
  "У": "Y", "Х": "X",
  "а": "a", "в": "b", "е": "e", "к": "k", "м": "m",
  "н": "h", "о": "o", "р": "p", "с": "c", "т": "t",
  "у": "y", "х": "x", "ѕ": "s", "і": "i",
};

/**
 * Normalize a Taxcom договор number for comparison so that values which look
 * identical on screen compare equal. Folds:
 *  - compatibility forms via NFKC (fullwidth digits/slash → ASCII);
 *  - every unicode dash/minus/fullwidth-hyphen → "-";
 *  - ALL whitespace incl. NBSP / narrow NBSP, soft hyphen, zero-width chars, BOM;
 *  - Cyrillic homoglyphs (С→C, Е→E, …) → Latin;
 *  - case (lowercased).
 * "CD-25/45507", "CD‑25/45507" (NB-hyphen), "CD–25/45507" (en-dash),
 * "СD-25/45507" (Cyrillic С), "CD-25/​45507" (zero-width space) and
 * " cd-25/45507 " all normalize to the same value.
 */
export function normalizeContractNumber(v: string | null | undefined): string {
  return (v ?? "")
    .normalize("NFKC")
    .replace(/[‐-―−－]/g, "-")
    .replace(/[\s ­​-‍⁠﻿]/g, "")
    .replace(/[Ѐ-ӿ]/g, (ch) => HOMOGLYPHS[ch] ?? ch)
    .toLowerCase();
}

/**
 * Decide whether the ACTIVE Taxcom ЛК (currentSession) is the one the connection
 * targets (contractNumber). True when they match (normalized). SAFE FALLBACK: if
 * currentSession is absent but there is exactly ONE available договор and it
 * matches the target, the current session can only be that ЛК — accept it. A
 * PRESENT-but-different currentSession is never overridden (real wrong-account).
 */
export function isCurrentAccountValid(
  currentSession: string | null | undefined,
  contractNumber: string | null | undefined,
  availableAgreementNumbers: (string | null | undefined)[],
): boolean {
  const want = normalizeContractNumber(contractNumber);
  if (!want) return true; // no target договор → nothing to enforce
  if (normalizeContractNumber(currentSession) === want) return true;
  const hasCurrent = Boolean(currentSession && String(currentSession).trim());
  if (!hasCurrent && availableAgreementNumbers.length === 1 && normalizeContractNumber(availableAgreementNumbers[0]) === want) {
    return true;
  }
  return false;
}
