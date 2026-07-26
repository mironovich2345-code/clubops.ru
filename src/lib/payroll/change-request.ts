// STAGE 10–11: pure logic for regional change proposals + GD approval.
// NO DB, NO eval. Single calc path: preview and apply both go through computeScheme
// (spec §23) — the UI never computes money locally. A pending request affects nothing;
// only an approved override merges into the effective scheme.
//
//   whitelist (§4)        — which scheme fields a regional may target, server-side
//   applyOverridesToParams — merge approved overrides onto the base snapshot params
//   effectiveSchemeParams  — snapshot + approved overrides → typed SchemeParams
//   previewChangeImpact    — current vs proposed accrual, reusing computeScheme
import { validateSchemeParams, type SchemeParams } from "@/lib/payroll/scheme";
import { computeScheme, type PeriodInput } from "@/lib/payroll/compute";
import type { CalcResult } from "@/lib/payroll/calc";

export type ChangeRequestType = "period_adjustment" | "future_scheme_change";
export type ChangeFieldType =
  | "percentage"
  | "base_salary"
  | "one_time_bonus"
  | "threshold"
  | "tier"
  | "scheme_parameters";

export const CHANGE_REQUEST_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "returned_for_revision",
  "approved",
  "rejected",
  "cancelled",
  "applied",
  "approved_pending_scheme_creation",
  "superseded",
] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];

/** A request is still "pending" (does not affect any total) in these states. */
export const PENDING_STATUSES: ReadonlySet<string> = new Set([
  "submitted",
  "under_review",
  "returned_for_revision",
]);
/** A request blocks closing the period while it is unresolved (spec §16). */
export const OPEN_BLOCKING_STATUSES: ReadonlySet<string> = new Set([
  "submitted",
  "under_review",
  "returned_for_revision",
]);
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "rejected",
  "cancelled",
  "applied",
  "superseded",
]);

// --- WHITELIST (spec §4) -----------------------------------------------------
// The ONLY scheme fields a regional director may propose to change, per scheme type.
// Anything not listed (companyId/clubId/employeeId/category/formula/engineVersion/
// paid amounts/advances/finance) is forbidden by omission. Value bounds are enforced
// separately by validateSchemeParams after the merge.
// unit tells the UI/action how to parse the entered value into the stored scalar:
//   kopeks — rubles × 100 (money)   bp — percent × 100 (basis points)
//   count  — plain integer          tiers — a percent-tier ladder (structured)
export type FieldUnit = "kopeks" | "bp" | "count" | "tiers";
export type FieldSpec = { key: string; fieldType: ChangeFieldType; unit: FieldUnit; labelRu: string };

const F = {
  base: (key: string, labelRu: string): FieldSpec => ({ key, fieldType: "base_salary", unit: "kopeks", labelRu }),
  pct: (key: string, labelRu: string): FieldSpec => ({ key, fieldType: "percentage", unit: "bp", labelRu }),
  kopeksThreshold: (key: string, labelRu: string): FieldSpec => ({ key, fieldType: "threshold", unit: "kopeks", labelRu }),
  countThreshold: (key: string, labelRu: string): FieldSpec => ({ key, fieldType: "threshold", unit: "count", labelRu }),
  tier: (key: string, labelRu: string): FieldSpec => ({ key, fieldType: "tier", unit: "tiers", labelRu }),
};

const WHITELIST: Record<string, FieldSpec[]> = {
  fixed_salary: [F.base("baseKopeks", "Фиксированный оклад")],
  salary_by_shifts: [F.base("baseKopeks", "Оклад"), F.countThreshold("shiftNorm", "Норматив смен")],
  salary_plus_percentage: [
    F.base("baseKopeks", "Оклад"),
    F.pct("belowPlanRateBp", "Процент ниже плана"),
    F.pct("atPlanRateBp", "Процент при выполнении плана"),
    F.countThreshold("shiftNorm", "Норматив смен"),
  ],
  sales_percentage: [F.pct("rateBp", "Процент с продаж")],
  hourly: [F.base("hourlyRateKopeks", "Ставка за час")],
  plan_adjusted_salary: [
    F.base("subscriptionsBaseKopeks", "Оклад (абонементы)"),
    F.base("ptBaseKopeks", "Оклад (ПТ)"),
    F.pct("maxAdjustmentBp", "Максимальная корректировка"),
  ],
  revenue_percentage: [
    F.base("fixedKopeks", "Фикс. часть"),
    F.pct("subsPercentBp", "Процент (абонементы)"),
    F.pct("ptPercentBp", "Процент (ПТ)"),
  ],
  profit_percentage: [F.pct("percentBp", "Процент от прибыли")],
  gym_trainer: [
    F.pct("lowRateBp", "Процент (пакеты ≤ порога)"),
    F.pct("highRateBp", "Процент (пакеты > порога)"),
    F.kopeksThreshold("thresholdKopeks", "Порог пакета"),
    F.pct("planThresholdBp", "Порог выполнения плана"),
  ],
  // role-categories engine v2
  role_club_manager: [
    F.base("abBaseKopeks", "Оклад (абонементы)"),
    F.base("ptBaseKopeks", "Оклад (ПТ)"),
    F.pct("limitBp", "Лимит корректировки (±)"),
  ],
  role_administrator: [F.base("shiftRateKopeks", "Ставка за смену")],
  role_sales_manager: [
    F.base("salaryFor15Kopeks", "Оклад за 15 смен"),
    F.countThreshold("shiftNorm", "Норматив смен"),
    F.tier("tiers", "Уровни процента по плану клуба"),
  ],
  role_night_manager: [
    F.base("shiftRateKopeks", "Ставка за ночную смену"),
    F.tier("tiers", "Уровни процента"),
  ],
  role_gym_trainer: [
    F.pct("newRateBp", "Процент (новые клиенты)"),
    F.pct("renewalRateBp", "Процент (продления)"),
  ],
  role_gym_head_trainer: [
    F.tier("newTiers", "Уровни процента (новые)"),
    F.tier("renewalTiers", "Уровни процента (продления)"),
  ],
  role_group_trainer: [
    F.base("hourRateKopeks", "Ставка за час"),
    F.pct("personalRateBp", "Личный процент"),
  ],
  role_group_head_trainer: [
    F.base("hourRateKopeks", "Ставка за час"),
    F.pct("personalRateBp", "Личный процент"),
    F.base("fixedBonusKopeks", "Фикс. доплата старшего"),
    F.pct("clubShareBp", "Процент с выручки клуба"),
  ],
};

/** Editable fields a regional may propose for a scheme type ([] if unknown). */
export function allowedFieldsForScheme(schemeType: string): FieldSpec[] {
  return WHITELIST[schemeType] ?? [];
}

/** Human label for a scheme field (falls back to the raw key). */
export function fieldLabel(schemeType: string, targetField: string): string {
  return allowedFieldsForScheme(schemeType).find((f) => f.key === targetField)?.labelRu ?? targetField;
}

/**
 * Server-side whitelist guard (spec §4). A regional may target `targetField` on
 * `schemeType` only if it is whitelisted AND the declared fieldType matches. Returns
 * a user-safe error otherwise. one_time_bonus is NOT a scheme field — it is handled as
 * a PayrollAdjustment and must not reach the scheme merge.
 */
export function assertFieldAllowed(
  schemeType: string,
  targetField: string,
  fieldType: ChangeFieldType,
): { ok: true; spec: FieldSpec } | { ok: false; error: string } {
  const spec = allowedFieldsForScheme(schemeType).find((f) => f.key === targetField);
  if (!spec) return { ok: false, error: `Поле «${targetField}» недоступно для изменения региональным директором.` };
  if (spec.fieldType !== fieldType)
    return { ok: false, error: `Тип изменения не совпадает с полем «${spec.labelRu}».` };
  return { ok: true, spec };
}

/**
 * Parse a regional's entered value into the STORED scalar for a field unit. kopeks/bp
 * accept "1 234,50" style input. tiers expects an already-structured ladder. Returns a
 * user-safe error on malformed input; bounds are re-checked later by validateSchemeParams.
 */
export function parseProposedScalar(unit: FieldUnit, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (unit === "tiers") {
    if (!Array.isArray(raw)) return { ok: false, error: "Уровни процента должны быть списком." };
    return { ok: true, value: raw };
  }
  const s = String(raw ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (s === "") return { ok: false, error: "Укажите новое значение." };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Значение должно быть неотрицательным числом." };
  if (unit === "kopeks") return { ok: true, value: Math.round(n * 100) };
  if (unit === "bp") return { ok: true, value: Math.round(n * 100) };
  return { ok: true, value: Math.round(n) }; // count
}

/** Human-readable rendering of a stored scalar for a unit (for old/new display). */
export function formatFieldValue(unit: FieldUnit, value: unknown): string {
  if (value == null) return "—";
  if (unit === "kopeks" && typeof value === "number") return `${(value / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
  if (unit === "bp" && typeof value === "number") return `${(value / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} %`;
  if (unit === "count" && typeof value === "number") return String(value);
  if (unit === "tiers" && Array.isArray(value))
    return value.map((t: { thresholdBp?: number; percentBp?: number }) => `${(Number(t?.thresholdBp ?? 0) / 100).toFixed(0)}%→${(Number(t?.percentBp ?? 0) / 100).toFixed(2)}%`).join(", ");
  return JSON.stringify(value);
}

// --- override model ----------------------------------------------------------
export type OverrideEntry = {
  requestId: string;
  targetField: string;
  fieldType: ChangeFieldType;
  value: unknown;
  appliedAt: string;
};
export type ApprovedOverrides = { overrides: OverrideEntry[] };

export function parseApprovedOverrides(json: string | null | undefined): ApprovedOverrides {
  if (!json) return { overrides: [] };
  try {
    const v = JSON.parse(json) as ApprovedOverrides;
    return Array.isArray(v?.overrides) ? { overrides: v.overrides } : { overrides: [] };
  } catch {
    return { overrides: [] };
  }
}

type Snapshot = { schemeId?: string; schemeType: string; params: Record<string, unknown>; effectiveFrom?: string };

function parseSnapshot(json: string | null | undefined): Snapshot | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as Snapshot;
    return s && typeof s.schemeType === "string" ? s : null;
  } catch {
    return null;
  }
}

/**
 * Merge override entries onto base params and RE-VALIDATE through validateSchemeParams
 * so every value stays within its documented bounds (kopeks ≥ 0, bp ≤ 100000, tier
 * ladders well-formed). Later overrides for the same field win. Returns the effective
 * typed SchemeParams or a user-safe error. The base snapshot is never mutated.
 */
export function applyOverridesToParams(
  schemeType: string,
  baseParams: Record<string, unknown>,
  overrides: OverrideEntry[],
): { ok: true; scheme: SchemeParams } | { ok: false; error: string } {
  const merged: Record<string, unknown> = { ...baseParams };
  for (const o of overrides) {
    const allowed = assertFieldAllowed(schemeType, o.targetField, o.fieldType);
    if (!allowed.ok) return { ok: false, error: allowed.error };
    merged[o.targetField] = o.value;
  }
  const res = validateSchemeParams(schemeType, merged);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, scheme: res.scheme };
}

/**
 * The EFFECTIVE scheme a calculation is computed from = base snapshot + approved
 * overrides. This replaces snapshotToSchemeParams everywhere a calc's overrides must
 * apply (spec §6: final = snapshot + approved overrides + manual inputs). Returns null
 * if the snapshot is missing/invalid; the caller treats that as "scheme not fixed".
 */
export function effectiveSchemeParams(
  snapshotJson: string | null,
  approvedOverridesJson: string | null,
): SchemeParams | null {
  const snap = parseSnapshot(snapshotJson);
  if (!snap) return null;
  const overrides = parseApprovedOverrides(approvedOverridesJson).overrides;
  if (overrides.length === 0) {
    const res = validateSchemeParams(snap.schemeType, snap.params);
    return res.ok ? res.scheme : null;
  }
  const res = applyOverridesToParams(snap.schemeType, snap.params, overrides);
  return res.ok ? res.scheme : null;
}

// --- preview (spec §8, §23) --------------------------------------------------
export type PreviewResult = {
  computable: boolean;
  reason?: string; // why uncomputable (shown instead of a fake 0)
  currentKopeks: number | null;
  proposedKopeks: number | null;
  differenceKopeks: number | null;
  currentBreakdown: CalcResult["breakdown"];
  proposedBreakdown: CalcResult["breakdown"];
  warnings: string[];
};

const PCT_BASE_INPUT: Record<string, (i: PeriodInput) => number> = {
  sales_percentage: (i) => i.salesKopeks ?? 0,
  salary_plus_percentage: (i) => i.netPersonalSalesKopeks ?? 0,
  profit_percentage: (i) => i.cityProfitKopeks ?? 0,
  revenue_percentage: (i) => (i.subscriptionsRevenueKopeks ?? 0) + (i.ptRevenueKopeks ?? 0),
  role_gym_trainer: (i) => (i.newSalesKopeks ?? 0) + (i.renewalSalesKopeks ?? 0),
  role_gym_head_trainer: (i) => (i.newSalesKopeks ?? 0) + (i.renewalSalesKopeks ?? 0),
  role_group_trainer: (i) => i.personalSalesKopeks ?? 0,
  role_group_head_trainer: (i) => (i.personalSalesKopeks ?? 0) + (i.clubGroupSalesKopeks ?? 0),
  role_sales_manager: (i) => i.personalSalesKopeks ?? 0,
  role_night_manager: (i) => i.personalSalesKopeks ?? 0,
};

/**
 * Impact of a proposed override on the automatic accrual — the SAME calc path as apply
 * (spec §23). `existingOverrides` are the already-approved overrides on the calc so the
 * "current" baseline reflects reality. For a percentage change with no revenue/sales
 * base entered, impact is genuinely indeterminate → computable=false with a reason,
 * NEVER a fabricated 0 (spec §8).
 */
export function previewChangeImpact(args: {
  schemeType: string;
  baseParams: Record<string, unknown>;
  input: PeriodInput;
  targetField: string;
  fieldType: ChangeFieldType;
  proposedValue: unknown;
  existingOverrides?: OverrideEntry[];
}): PreviewResult {
  const { schemeType, baseParams, input, targetField, fieldType, proposedValue } = args;
  const existing = args.existingOverrides ?? [];
  const empty: CalcResult["breakdown"] = [];

  const allowed = assertFieldAllowed(schemeType, targetField, fieldType);
  if (!allowed.ok)
    return { computable: false, reason: allowed.error, currentKopeks: null, proposedKopeks: null, differenceKopeks: null, currentBreakdown: empty, proposedBreakdown: empty, warnings: [] };

  const current = applyOverridesToParams(schemeType, baseParams, existing);
  if (!current.ok)
    return { computable: false, reason: "Текущая схема некорректна — невозможно рассчитать влияние.", currentKopeks: null, proposedKopeks: null, differenceKopeks: null, currentBreakdown: empty, proposedBreakdown: empty, warnings: [] };

  const proposedOverride: OverrideEntry = { requestId: "preview", targetField, fieldType, value: proposedValue, appliedAt: "" };
  const proposed = applyOverridesToParams(schemeType, baseParams, [...existing, proposedOverride]);
  if (!proposed.ok)
    return { computable: false, reason: proposed.error, currentKopeks: null, proposedKopeks: null, differenceKopeks: null, currentBreakdown: empty, proposedBreakdown: empty, warnings: [] };

  const warnings: string[] = [];
  // A percentage change only bites when there is a revenue/sales base. Absent base →
  // impact is indeterminate; do not present a misleading 0 (spec §8).
  if (fieldType === "percentage") {
    const baseFn = PCT_BASE_INPUT[schemeType];
    if (baseFn && baseFn(input) <= 0)
      return { computable: false, reason: "Невозможно рассчитать влияние: база (выручка/продажи) не введена.", currentKopeks: null, proposedKopeks: null, differenceKopeks: null, currentBreakdown: empty, proposedBreakdown: empty, warnings };
  }

  const cur = computeScheme(current.scheme, input);
  const prop = computeScheme(proposed.scheme, input);
  return {
    computable: true,
    currentKopeks: cur.amountKopeks,
    proposedKopeks: prop.amountKopeks,
    differenceKopeks: prop.amountKopeks - cur.amountKopeks,
    currentBreakdown: cur.breakdown,
    proposedBreakdown: prop.breakdown,
    warnings,
  };
}

// --- state machine (spec §3, §13, §15) ---------------------------------------
export type Transition = "submit" | "start_review" | "return" | "reject" | "approve" | "cancel" | "resubmit";

const ALLOWED_FROM: Record<Transition, ReadonlySet<string>> = {
  submit: new Set(["draft"]),
  resubmit: new Set(["returned_for_revision"]),
  start_review: new Set(["submitted"]),
  return: new Set(["submitted", "under_review"]),
  reject: new Set(["submitted", "under_review"]),
  approve: new Set(["submitted", "under_review"]),
  cancel: new Set(["draft", "submitted", "under_review", "returned_for_revision"]),
};

export function canTransition(from: string, t: Transition): boolean {
  return ALLOWED_FROM[t]?.has(from) ?? false;
}

export type HistoryEvent = {
  at: string;
  by: string;
  action: string;
  fromStatus?: string;
  toStatus?: string;
  comment?: string;
  revision?: number;
  note?: string;
};

// --- display labels (client-safe) --------------------------------------------
export const STATUS_LABEL: Record<string, { label: string; tone: "amber" | "sky" | "emerald" | "rose" | "slate" }> = {
  draft: { label: "Черновик", tone: "slate" },
  submitted: { label: "На согласовании", tone: "amber" },
  under_review: { label: "На рассмотрении", tone: "amber" },
  returned_for_revision: { label: "Возвращено на доработку", tone: "sky" },
  approved: { label: "Согласовано", tone: "emerald" },
  applied: { label: "Применено", tone: "emerald" },
  approved_pending_scheme_creation: { label: "Согласовано (ожидает создания схемы)", tone: "sky" },
  rejected: { label: "Отклонено", tone: "rose" },
  cancelled: { label: "Отменено", tone: "slate" },
  superseded: { label: "Заменено", tone: "slate" },
};

export const REQUEST_TYPE_LABEL: Record<string, string> = {
  period_adjustment: "Разовая корректировка периода",
  future_scheme_change: "Изменение схемы с будущей даты",
};

export const FIELD_TYPE_LABEL: Record<string, string> = {
  percentage: "Процент",
  base_salary: "Окладная часть",
  one_time_bonus: "Разовая премия",
  threshold: "Порог/норматив",
  tier: "Уровни процента",
  scheme_parameters: "Параметры схемы",
};

export function appendHistory(historyJson: string | null | undefined, event: HistoryEvent): string {
  let list: HistoryEvent[] = [];
  if (historyJson) {
    try {
      const v = JSON.parse(historyJson);
      if (Array.isArray(v)) list = v as HistoryEvent[];
    } catch {
      /* start fresh */
    }
  }
  list.push(event);
  return JSON.stringify(list);
}
