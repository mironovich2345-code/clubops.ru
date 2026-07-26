// Historical (effective-dated) pay schemes. Changing an employee's pay never mutates
// a past scheme row: a new EmployeePayScheme is appended with a new effectiveFrom and
// the previously-open scheme is closed at that boundary. Because each calculation
// resolves the scheme in effect at its own period (and Stage 3 snapshots it), editing
// pay going forward can NEVER recompute a closed month.
import type { EmployeePayScheme } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PAYROLL_SCHEME_LABELS } from "@/lib/payroll/enums";
import { validateSchemeParams, type SchemeParams } from "@/lib/payroll/scheme";
import { isLiveForResolver } from "@/lib/payroll/scheme-version";

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
  return resolveEffectiveScheme(liveRows(rows), at);
}

// --- STAGE 2 resolver: priority (employee → club-category) + conflict + tenant-safe ---

const ms2 = (d: Date | string): number => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** Only committed (resolver-live) versions drive a calculation — draft / pending_approval
 * / rejected / cancelled / archived never participate (spec §3/§6). */
function liveRows(rows: readonly EmployeePayScheme[]): EmployeePayScheme[] {
  return rows.filter((s) => isLiveForResolver(s.status));
}

/** Conflict when ≥2 LIVE versions cover the same date `at` — genuinely ambiguous overlap
 * (spec §11). With versioning any two covering intervals are invalid, so we block rather
 * than silently pick the newest. */
function hasSchemeConflict(rows: readonly EmployeePayScheme[], at: Date): boolean {
  const t = at.getTime();
  const covering = liveRows(rows).filter((s) => ms2(s.effectiveFrom) <= t && (s.effectiveTo == null || ms2(s.effectiveTo) > t));
  return covering.length >= 2;
}

export type SchemeResolution =
  | { ok: true; scheme: EmployeePayScheme; level: "employee" | "category" }
  | { ok: false; reason: "not_configured" | "conflict"; message: string };

/**
 * Resolve the scheme that drives a calculation, by PRIORITY (spec §4):
 *   1. employee-specific: company + club + employeeId, effective at `at`;
 *   2. club-category:      company + club + employeeId=null + position, effective at `at`;
 *   3. otherwise → "Схема не настроена".
 * Never takes another club's/company's/position's scheme (queries are fully scoped). A
 * genuine same-level ambiguity returns a `conflict` that blocks the calc.
 */
export async function resolveSchemeForCalc(args: { companyId: string; clubId: string; employeeId: string; position: string | null; at: Date }): Promise<SchemeResolution> {
  const { companyId, clubId, employeeId, position, at } = args;

  // Resolve by the PERIOD date `at` among committed versions only (spec §3/§9). A
  // scheduled version whose effectiveFrom has passed is picked by date regardless of a
  // stale status; draft/pending/rejected/cancelled/archived never participate.
  const empRows = await prisma.employeePayScheme.findMany({ where: { companyId, clubId, employeeId }, orderBy: [{ effectiveFrom: "desc" }] });
  if (hasSchemeConflict(empRows, at)) return { ok: false, reason: "conflict", message: "Найдено несколько действующих схем сотрудника на дату периода. Требуется исправление настроек." };
  const emp = resolveEffectiveScheme(liveRows(empRows), at);
  if (emp) return { ok: true, scheme: emp, level: "employee" };

  if (position) {
    const catRows = await prisma.employeePayScheme.findMany({ where: { companyId, clubId, employeeId: null, position }, orderBy: [{ effectiveFrom: "desc" }] });
    if (hasSchemeConflict(catRows, at)) return { ok: false, reason: "conflict", message: "Найдено несколько действующих схем категории на дату периода. Требуется исправление настроек." };
    const cat = resolveEffectiveScheme(liveRows(catRows), at);
    if (cat) return { ok: true, scheme: cat, level: "category" };
  }

  return { ok: false, reason: "not_configured", message: "Схема не настроена для этого клуба/сотрудника/категории." };
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
