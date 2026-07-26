// STAGE 12: pure logic for append-only VERSIONED pay schemes. No DB, no eval.
//   logical key       — (company, club, employeeId ?? ALL, position): version scope
//   version           — increments within the logical key (never a global max)
//   status lifecycle  — draft → pending_approval → approved → scheduled/active →
//                       superseded → archived; + rejected/cancelled dead-ends
//   resolver liveness — only committed statuses (approved/scheduled/active/superseded)
//                       participate; the effective one is picked BY DATE (period month),
//                       so a stale `status` never overrides the interval maths
//   immutability      — a used/active/superseded version's parameters are frozen
import { payrollCategoryOfPosition } from "@/lib/payroll/categories";

export const SCHEME_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "active",
  "superseded",
  "archived",
  "rejected",
  "cancelled",
] as const;
export type SchemeStatus = (typeof SCHEME_STATUSES)[number];

// Statuses that carry a committed effective interval and thus participate in resolution.
// draft/pending_approval/rejected/cancelled/archived NEVER drive a calculation.
export const RESOLVER_LIVE_STATUSES: ReadonlySet<string> = new Set([
  "approved",
  "scheduled",
  "active",
  "superseded",
]);
export function isLiveForResolver(status: string): boolean {
  return RESOLVER_LIVE_STATUSES.has(status);
}

// A version whose parameters must never change (used in a snapshot OR already committed).
export const FROZEN_STATUSES: ReadonlySet<string> = new Set(["active", "superseded", "archived"]);

// Fields that may NEVER change once a version is frozen/used (spec §18).
export const IMMUTABLE_SCHEME_FIELDS = [
  "paramsJson",
  "payrollCategory",
  "employeeId",
  "clubId",
  "companyId",
  "effectiveFrom",
  "version",
  "schemeType",
] as const;

/**
 * Logical scheme key — the chain within which `version` increments. Identical grouping to
 * the resolver: a company+club+category (employeeId=null) chain is independent from a
 * specific employee's chain. `position` distinguishes category chains; for an employee the
 * position is still part of the key so a re-assigned employee starts a fresh chain safely.
 */
export function logicalSchemeKey(s: { companyId: string; clubId: string; employeeId: string | null; position: string | null }): string {
  return `${s.companyId}|${s.clubId}|${s.employeeId ?? "ALL"}|${s.position ?? ""}`;
}

/** Next version within a logical key = max(existing version) + 1 (scoped, never global). */
export function nextVersion(existingInKey: ReadonlyArray<{ version: number }>): number {
  let max = 0;
  for (const s of existingInKey) if (s.version > max) max = s.version;
  return max + 1;
}

/** Derive the payroll category label from a position (nullable-safe). */
export function categoryOfPosition(position: string | null): string | null {
  if (!position) return null;
  const cat = payrollCategoryOfPosition(position);
  return cat === "unknown" ? null : cat;
}

// --- interval maths (end-exclusive: from ≤ t < to) --------------------------
const ms = (d: Date | string): number => (d instanceof Date ? d.getTime() : new Date(d).getTime());

export type Interval = { effectiveFrom: Date | string; effectiveTo: Date | string | null };

/** True if two end-exclusive intervals overlap on any instant. */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  const aFrom = ms(a.effectiveFrom), aTo = a.effectiveTo == null ? Infinity : ms(a.effectiveTo);
  const bFrom = ms(b.effectiveFrom), bTo = b.effectiveTo == null ? Infinity : ms(b.effectiveTo);
  return aFrom < bTo && bFrom < aTo;
}

/**
 * Detect an overlapping pair among LIVE versions of one logical key (spec §5/§11). Returns
 * the offending pair's ids, or null if the timeline is clean. Rows must already be filtered
 * to a single logical key and to resolver-live statuses.
 */
export function findOverlap<T extends Interval & { id: string; status: string }>(rows: readonly T[]): { a: string; b: string } | null {
  const live = rows.filter((r) => isLiveForResolver(r.status));
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (intervalsOverlap(live[i], live[j])) return { a: live[i].id, b: live[j].id };
    }
  }
  return null;
}

// --- status state machine (spec §6) -----------------------------------------
export type SchemeTransition =
  | "submit"        // draft → pending_approval
  | "approve"       // pending_approval → approved
  | "reject"        // pending_approval → rejected
  | "return"        // pending_approval → draft (rework)
  | "activate"      // approved/scheduled → active   (by date, idempotent)
  | "schedule"      // approved → scheduled          (future effectiveFrom)
  | "supersede"     // active/scheduled → superseded (a newer version took over)
  | "archive"       // draft/rejected/cancelled/superseded → archived
  | "cancel";       // draft/pending_approval → cancelled

const ALLOWED_FROM: Record<SchemeTransition, ReadonlySet<string>> = {
  submit: new Set(["draft"]),
  approve: new Set(["pending_approval"]),
  reject: new Set(["pending_approval"]),
  return: new Set(["pending_approval"]),
  activate: new Set(["approved", "scheduled"]),
  schedule: new Set(["approved"]),
  supersede: new Set(["active", "scheduled", "approved"]),
  archive: new Set(["draft", "rejected", "cancelled", "superseded"]),
  cancel: new Set(["draft", "pending_approval"]),
};

export function canSchemeTransition(from: string, t: SchemeTransition): boolean {
  return ALLOWED_FROM[t]?.has(from) ?? false;
}

/**
 * The committed status for a freshly-materialised/approved version given its effectiveFrom
 * relative to the reference instant: future → scheduled, else active (spec §6).
 */
export function committedStatusFor(effectiveFrom: Date, at: Date): "scheduled" | "active" {
  return effectiveFrom.getTime() > at.getTime() ? "scheduled" : "active";
}

/** Guard: does an update payload touch a frozen field? Returns the offending field or null. */
export function frozenFieldTouched(patch: Record<string, unknown>): string | null {
  for (const f of IMMUTABLE_SCHEME_FIELDS) if (f in patch) return f;
  return null;
}

// --- presentational param formatting / diff (client-safe) --------------------
const PARAM_LABELS: Record<string, string> = {
  abBaseKopeks: "Оклад (абонементы)",
  ptBaseKopeks: "Оклад (ПТ)",
  subscriptionsBaseKopeks: "Оклад (абонементы)",
  baseKopeks: "Оклад",
  salaryFor15Kopeks: "Оклад за 15 смен",
  shiftRateKopeks: "Ставка за смену",
  hourRateKopeks: "Ставка за час",
  hourlyRateKopeks: "Ставка за час",
  fixedKopeks: "Фикс. часть",
  fixedBonusKopeks: "Фикс. доплата старшего",
  thresholdKopeks: "Порог пакета",
  limitBp: "Лимит корректировки",
  maxAdjustmentBp: "Максимальная корректировка",
  rateBp: "Процент с продаж",
  percentBp: "Процент от прибыли",
  belowPlanRateBp: "Процент ниже плана",
  atPlanRateBp: "Процент при выполнении плана",
  subsPercentBp: "Процент (абонементы)",
  ptPercentBp: "Процент (ПТ)",
  newRateBp: "Процент (новые)",
  renewalRateBp: "Процент (продления)",
  personalRateBp: "Личный процент",
  clubShareBp: "Процент с выручки клуба",
  lowRateBp: "Процент (≤ порога)",
  highRateBp: "Процент (> порога)",
  planThresholdBp: "Порог выполнения плана",
  shiftNorm: "Норматив смен",
  tiers: "Уровни процента",
  newTiers: "Уровни (новые)",
  renewalTiers: "Уровни (продления)",
};

export type ParamRow = { key: string; label: string; display: string; kind: "kopeks" | "bp" | "num" | "tiers" };

function classifyKey(key: string): ParamRow["kind"] {
  if (/tiers$/i.test(key)) return "tiers";
  if (/Kopeks$/.test(key)) return "kopeks";
  if (/Bp$/.test(key)) return "bp";
  return "num";
}

export function formatParamValue(kind: ParamRow["kind"], value: unknown): string {
  if (value == null) return "—";
  if (kind === "kopeks" && typeof value === "number") return `${(value / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
  if (kind === "bp" && typeof value === "number") return `${(value / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} %`;
  if (kind === "tiers" && Array.isArray(value)) return value.map((t: { thresholdBp?: number; percentBp?: number }) => `${(Number(t?.thresholdBp ?? 0) / 100).toFixed(0)}%→${(Number(t?.percentBp ?? 0) / 100).toFixed(2)}%`).join(", ");
  return String(value);
}

/** Ordered, human-readable rows for a params object. */
export function describeParamRows(params: Record<string, unknown>): ParamRow[] {
  return Object.keys(params).map((key) => {
    const kind = classifyKey(key);
    return { key, label: PARAM_LABELS[key] ?? key, display: formatParamValue(kind, params[key]), kind };
  });
}

export type DiffRow = { key: string; label: string; kind: ParamRow["kind"]; oldDisplay: string; newDisplay: string; changed: boolean };

/** Compare two params objects for the version-compare UI (spec §13). */
export function diffParamRows(oldParams: Record<string, unknown>, newParams: Record<string, unknown>): DiffRow[] {
  const keys = [...new Set([...Object.keys(oldParams), ...Object.keys(newParams)])];
  return keys.map((key) => {
    const kind = classifyKey(key);
    const oldDisplay = formatParamValue(kind, oldParams[key]);
    const newDisplay = formatParamValue(kind, newParams[key]);
    return { key, label: PARAM_LABELS[key] ?? key, kind, oldDisplay, newDisplay, changed: oldDisplay !== newDisplay };
  });
}
