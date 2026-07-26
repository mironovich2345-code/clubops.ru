// STAGE 13: pure helpers for cashier identities, mappings and per-receipt attribution.
// No DB, no eval. Keys/fingerprints here are the safety backbone: identities never merge
// across sources, one physical receipt contributes to payroll once (even across providers),
// and attribution respects date/interval/employment.
import { normalizeCashierName, isExactNameMatch } from "@/lib/ofd/cashier-normalize";

export const MAPPING_STATUSES = [
  "auto_matched",
  "confirmed",
  "unmatched",
  "ambiguous",
  "manually_assigned",
  "excluded",
  "inactive",
] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

export const MATCH_METHODS = [
  "exact_normalized_name",
  "alias",
  "manual",
  "imported_external_id",
  "historical_mapping",
] as const;

// Only these statuses drive payroll attribution (spec §4): a suggestion never pays out.
export const ATTRIBUTING_STATUSES: ReadonlySet<string> = new Set(["confirmed", "manually_assigned"]);
export function isAttributingStatus(status: string): boolean {
  return ATTRIBUTING_STATUSES.has(status);
}

export const ATTRIBUTION_TYPES = [
  "personal_sale",
  "refund",
  "trainer_new",
  "trainer_renewal",
  "group_personal",
] as const;
export type AttributionType = (typeof ATTRIBUTION_TYPES)[number];

/**
 * Identity key — one cashier per SOURCE. Same name in a different company / provider /
 * connection / KKT is a DIFFERENT identity (spec §3, never auto-merged). fnNumber pins the
 * KKT; normalizedName pins the person within that source.
 */
export function buildIdentityKey(args: { companyId: string; provider: string; ofdConnectionId: string; fnNumber: string; normalizedName: string }): string {
  return [args.companyId, args.provider, args.ofdConnectionId, args.fnNumber, args.normalizedName].join("|");
}

/**
 * Stable fiscal fingerprint of a physical receipt — provider-INDEPENDENT so the same receipt
 * arriving from Taxcom and Astral maps to one fingerprint (spec §11). Never amount+time only.
 */
export function receiptFiscalFingerprint(r: { fnNumber: string; fiscalDocumentNumber: number; fiscalSign: string | null; operationType: string }): string {
  return [r.fnNumber, r.fiscalDocumentNumber, r.fiscalSign ?? "", r.operationType].join(":");
}

/** Attribution dedupe key — one physical receipt affects one attribution type exactly once. */
export function attributionDedupeKey(fingerprint: string, attributionType: string): string {
  return `${fingerprint}:${attributionType}`;
}

// --- effective-interval + employment maths (end-exclusive) -------------------
const ms = (d: Date | string): number => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** Is instant `at` inside [from, to) ? (to=null → open). */
export function coversDate(interval: { effectiveFrom: Date | string; effectiveTo: Date | string | null }, at: Date): boolean {
  const from = ms(interval.effectiveFrom);
  const to = interval.effectiveTo == null ? Infinity : ms(interval.effectiveTo);
  return from <= at.getTime() && at.getTime() < to;
}

/** Employment window check: receipt date must be within [hireDate, dismissedAt] (open-ended). */
export function withinEmployment(emp: { hireDate: Date | string | null; dismissedAt: Date | string | null; status: string }, at: Date): boolean {
  const t = at.getTime();
  if (emp.hireDate != null && t < ms(emp.hireDate)) return false;
  if (emp.dismissedAt != null && t > ms(emp.dismissedAt)) return false;
  return true;
}

/** Do two mapping intervals for the SAME identity overlap? (forbidden, spec §8). */
export function mappingIntervalsOverlap(a: { effectiveFrom: Date | string; effectiveTo: Date | string | null }, b: { effectiveFrom: Date | string; effectiveTo: Date | string | null }): boolean {
  const aFrom = ms(a.effectiveFrom), aTo = a.effectiveTo == null ? Infinity : ms(a.effectiveTo);
  const bFrom = ms(b.effectiveFrom), bTo = b.effectiveTo == null ? Infinity : ms(b.effectiveTo);
  return aFrom < bTo && bFrom < aTo;
}

// --- auto-match suggestion (spec §7) ----------------------------------------
export type EmployeeCandidate = { id: string; fullName: string; normalizedName: string; status: string; hireDate: Date | string | null; dismissedAt: Date | string | null };

export type MatchSuggestion =
  | { status: "auto_matched"; employeeId: string; matchMethod: "exact_normalized_name"; confidence: number }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "unmatched" };

/**
 * Suggest an employee for a cashier identity (spec §7). Exact normalized full-name match to
 * exactly ONE active employee of the club employed at the receipt date → auto_matched
 * (suggestion, not a payout). Several matches → ambiguous. None → unmatched. NEVER matches by
 * surname-only or fuzzy — those are advisory confidence only, surfaced in the UI, not here.
 */
export function suggestEmployee(identityNormalized: string, candidates: readonly EmployeeCandidate[], receiptDate: Date): MatchSuggestion {
  const exact = candidates.filter(
    (c) => c.status === "active" && isExactNameMatch(identityNormalized, c.normalizedName) && withinEmployment(c, receiptDate),
  );
  if (exact.length === 1) return { status: "auto_matched", employeeId: exact[0].id, matchMethod: "exact_normalized_name", confidence: 100 };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact.map((c) => c.id) };
  return { status: "unmatched" };
}

/** Convenience: normalize a raw employee name for candidate comparison. */
export function toCandidate(e: { id: string; fullName: string; status: string; hireDate: Date | string | null; dismissedAt: Date | string | null }): EmployeeCandidate {
  return { id: e.id, fullName: e.fullName, normalizedName: normalizeCashierName(e.fullName), status: e.status, hireDate: e.hireDate, dismissedAt: e.dismissedAt };
}
