// Historical (effective-dated) pay schemes. Changing an employee's pay never mutates
// a past scheme row: a new EmployeePayScheme is appended with a new effectiveFrom and
// the previously-open scheme is closed at that boundary. Because each calculation
// resolves the scheme in effect at its own period (and Stage 3 snapshots it), editing
// pay going forward can NEVER recompute a closed month.
import type { EmployeePayScheme } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PAYROLL_SCHEME_LABELS } from "@/lib/payroll/enums";
import { validateSchemeParams, type SchemeParams } from "@/lib/payroll/scheme";

export type SchemeWindow = { effectiveFrom: Date | string; effectiveTo: Date | string | null };

const ms = (d: Date | string): number => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/**
 * Pure: the scheme in effect at instant `at` — effectiveFrom ≤ at < effectiveTo (or
 * ∞ when open). Among overlapping windows the latest effectiveFrom wins. Returns null
 * when nothing is in effect (e.g. before the first scheme).
 */
export function resolveEffectiveScheme<T extends SchemeWindow>(schemes: readonly T[], at: Date): T | null {
  const t = at.getTime();
  let best: T | null = null;
  for (const s of schemes) {
    const from = ms(s.effectiveFrom);
    const to = s.effectiveTo == null ? Infinity : ms(s.effectiveTo);
    if (from <= t && t < to) {
      if (best == null || from > ms(best.effectiveFrom)) best = s;
    }
  }
  return best;
}

/**
 * Pure: when appending a new scheme effective at `from` for a key, which existing
 * open schemes (effectiveTo == null) must be closed, and at what boundary. An open
 * scheme starting on/before `from` is closed at `from`; one starting strictly after
 * `from` is left untouched (the new row slots before it and stays open until then).
 */
export function schemesToSupersede<T extends SchemeWindow & { id: string }>(
  existing: readonly T[],
  from: Date,
): Array<{ id: string; effectiveTo: Date }> {
  const t = from.getTime();
  const out: Array<{ id: string; effectiveTo: Date }> = [];
  for (const s of existing) {
    if (s.effectiveTo == null && ms(s.effectiveFrom) <= t) out.push({ id: s.id, effectiveTo: from });
  }
  return out;
}

/** Employee-specific schemes (newest first), scope-safe caller. */
export async function getSchemesForEmployee(
  companyId: string,
  employeeId: string,
): Promise<EmployeePayScheme[]> {
  return prisma.employeePayScheme.findMany({
    where: { companyId, employeeId },
    orderBy: [{ effectiveFrom: "desc" }],
  });
}

/** The scheme in effect for an employee at a club at `at` (employee-specific rows). */
export async function getEffectiveSchemeForEmployee(
  companyId: string,
  clubId: string,
  employeeId: string,
  at: Date,
): Promise<EmployeePayScheme | null> {
  const rows = await prisma.employeePayScheme.findMany({
    where: { companyId, clubId, employeeId },
    orderBy: [{ effectiveFrom: "desc" }],
  });
  return resolveEffectiveScheme(rows, at);
}

/** Parse + re-validate a stored scheme's paramsJson into a typed SchemeParams. */
export function parseSchemeParams(scheme: Pick<EmployeePayScheme, "schemeType" | "paramsJson">): SchemeParams | null {
  let raw: unknown = {};
  try {
    raw = JSON.parse(scheme.paramsJson);
  } catch {
    return null;
  }
  const res = validateSchemeParams(scheme.schemeType, raw);
  return res.ok ? res.scheme : null;
}

/** Short human label for a scheme row (for tables). */
export function describeSchemeShort(scheme: Pick<EmployeePayScheme, "schemeType">): string {
  return PAYROLL_SCHEME_LABELS[scheme.schemeType] ?? scheme.schemeType;
}
