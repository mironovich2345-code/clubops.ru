// WAVE 1 — Прогнозный ФОТ (payroll forecast). READ-ONLY, forward-looking.
//
// This is number A in the four-number model (forecast / budget / accrual / payment). It is
// DERIVED from active EmployeePayScheme rows for a FUTURE period; it is NEVER stored as a
// fact, NEVER enters PaymentObligation[], and NEVER mutates a budget. A change to a scheme
// changes only this forecast — approved/closed periods are untouched.
//
// Honest-incompleteness rule (spec §5): where a scheme has a variable component we cannot
// project without planned targets (sales/plan/shifts/hours), we surface a WARNING and mark
// confidence "partial". We never emit a silent 0 as if it were a real forecast — the
// guaranteed (base) component is the confident lower bound; the variable component is flagged.

import { prisma } from "@/lib/prisma";
import { getEmployeesForScope } from "@/lib/club-employees";
import { getSchemesForEmployee, parseSchemeParams, resolveEffectiveScheme } from "@/lib/payroll/schemes";
import type { SchemeParams } from "@/lib/payroll/scheme";
import { payrollCategoryOfPosition, type PayrollCalcCategoryOrUnknown } from "@/lib/payroll/categories";

// The 5 forecast categories (spec §4). Distinct from the 8 calc categories and the 5 UI
// cards — this is the budgeting rollup. "other" catches unknown/unmapped positions.
export const FORECAST_CATEGORIES = ["management", "administrative", "gym_trainers", "group_trainers", "other"] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];
export const FORECAST_CATEGORY_LABELS: Record<ForecastCategory, string> = {
  management: "Управляющий",
  administrative: "Административный состав",
  gym_trainers: "Тренеры ТЗ",
  group_trainers: "Тренеры ГП",
  other: "Другое",
};

/** Map an 8-way calc category to the 5-way forecast rollup. */
export function forecastCategoryOfCalc(cat: PayrollCalcCategoryOrUnknown): ForecastCategory {
  switch (cat) {
    case "club_manager":
      return "management";
    case "sales_manager":
    case "administrator":
    case "night_manager":
      return "administrative";
    case "gym_head_trainer":
    case "gym_trainer":
      return "gym_trainers";
    case "group_head_trainer":
    case "group_trainer":
      return "group_trainers";
    default:
      return "other";
  }
}

/** Forecast rollup category for a raw position string. */
export function forecastCategoryOfPosition(position: string | null | undefined): ForecastCategory {
  return forecastCategoryOfCalc(payrollCategoryOfPosition(position));
}

// The guaranteed (base) component the scheme pays even at zero sales/plan, and whether it
// carries a variable part we cannot project here. PURE — unit-tested by the pilot.
export type SchemeBaseForecast = { baseKopeks: number; hasVariable: boolean; note?: string };

/**
 * Guaranteed base + variable-flag per scheme type. The base is the confident lower bound;
 * `hasVariable` drives the «Прогноз неполный» warning. We never invent commission/plan
 * numbers — those require actual targets the forecast does not have.
 */
export function schemeGuaranteedBase(scheme: SchemeParams): SchemeBaseForecast {
  switch (scheme.type) {
    case "fixed_salary":
      return { baseKopeks: scheme.params.baseKopeks, hasVariable: false };
    case "salary_by_shifts":
      return { baseKopeks: scheme.params.baseKopeks, hasVariable: true, note: "зависит от числа смен" };
    case "salary_plus_percentage":
      return { baseKopeks: scheme.params.baseKopeks, hasVariable: true, note: "оклад + процент от продаж" };
    case "revenue_percentage":
      return { baseKopeks: scheme.params.fixedKopeks, hasVariable: true, note: "фикс + процент от выручки" };
    case "plan_adjusted_salary":
      return { baseKopeks: scheme.params.subscriptionsBaseKopeks + scheme.params.ptBaseKopeks, hasVariable: true, note: "оклад с план-факт корректировкой" };
    case "role_club_manager":
      return { baseKopeks: scheme.params.abBaseKopeks + scheme.params.ptBaseKopeks, hasVariable: true, note: "оклад + бонус по лимиту" };
    case "role_sales_manager":
      return { baseKopeks: scheme.params.salaryFor15Kopeks, hasVariable: true, note: "оклад за норму смен + проценты" };
    case "role_group_head_trainer":
      return { baseKopeks: scheme.params.fixedBonusKopeks, hasVariable: true, note: "фикс. доплата + переменная часть" };
    // Pure-variable / shift-or-hour-dependent schemes: no guaranteed base to project.
    case "sales_percentage":
    case "profit_percentage":
    case "gym_trainer":
    case "hourly":
    case "role_administrator":
    case "role_night_manager":
    case "role_gym_trainer":
    case "role_gym_head_trainer":
    case "role_group_trainer":
      return { baseKopeks: 0, hasVariable: true, note: "полностью переменная часть" };
    case "mixed":
      return { baseKopeks: 0, hasVariable: true, note: "нестандартная схема" };
    default: {
      // Exhaustiveness guard — a new scheme type must be classified explicitly, never
      // silently forecast as 0.
      const _never: never = scheme;
      void _never;
      return { baseKopeks: 0, hasVariable: true, note: "неизвестная схема" };
    }
  }
}

export type ForecastWarning = {
  code: "no_scheme" | "scheme_conflict" | "variable_component" | "legal_entity_unknown";
  employeeId?: string;
  employeeName?: string;
  clubId?: string;
  message: string;
};

export type PayrollForecastResult = {
  totalKopeks: number;
  byClub: Record<string, number>;
  byCategory: Record<ForecastCategory, number>;
  byEmployee: Record<string, number>;
  byLegalEntity: Record<string, number>; // key "" = не распределено по юрлицу
  warnings: ForecastWarning[];
  confidence: "complete" | "partial";
  employeeCount: number;
  schemedCount: number; // employees with a live scheme contributing a base
};

const UNASSIGNED_LE = ""; // legal entity unknown → explicit bucket, never silently dropped

function emptyByCategory(): Record<ForecastCategory, number> {
  return { management: 0, administrative: 0, gym_trainers: 0, group_trainers: 0, other: 0 };
}

/**
 * Forecast the planned ФОТ for a FUTURE period from active schemes.
 * `atDate` is the date the scheme is resolved at (period start). Aggregates by
 * club / category / employee / legal entity, with honest missing-data warnings.
 */
export async function calculatePayrollForecast(args: {
  companyId: string;
  clubIds: string[];
  atDate: Date;
  clubId?: string; // optional narrow within clubIds
}): Promise<PayrollForecastResult> {
  const { companyId, atDate } = args;
  const scopeClubs = args.clubId && args.clubIds.includes(args.clubId) ? [args.clubId] : args.clubIds;

  const result: PayrollForecastResult = {
    totalKopeks: 0,
    byClub: {},
    byCategory: emptyByCategory(),
    byEmployee: {},
    byLegalEntity: {},
    warnings: [],
    confidence: "complete",
    employeeCount: 0,
    schemedCount: 0,
  };
  if (scopeClubs.length === 0) return result;

  const employees = await getEmployeesForScope(companyId, scopeClubs, { status: "active" });
  result.employeeCount = employees.length;

  // Primary legal entity per club (fallback when the employee has no defaultLegalEntityId).
  const clubPrimaryLE = new Map<string, string>();
  const links = await prisma.clubLegalEntity.findMany({
    where: { clubId: { in: scopeClubs }, isActive: true },
    select: { clubId: true, legalEntityId: true, isPrimary: true },
    orderBy: [{ isPrimary: "desc" }],
  });
  for (const l of links) {
    if (!clubPrimaryLE.has(l.clubId)) clubPrimaryLE.set(l.clubId, l.legalEntityId);
  }

  for (const e of employees) {
    const schemes = await getSchemesForEmployee(companyId, e.id);
    const live = resolveEffectiveScheme(
      schemes.filter((s) => s.status === "approved" || s.status === "scheduled" || s.status === "active" || s.status === "superseded"),
      atDate,
    );
    if (!live) {
      result.warnings.push({ code: "no_scheme", employeeId: e.id, employeeName: e.fullName, clubId: e.clubId, message: `Схема оплаты не настроена: ${e.fullName}` });
      result.confidence = "partial";
      continue;
    }
    const parsed = parseSchemeParams(live);
    if (!parsed) {
      result.warnings.push({ code: "no_scheme", employeeId: e.id, employeeName: e.fullName, clubId: e.clubId, message: `Схема оплаты повреждена: ${e.fullName}` });
      result.confidence = "partial";
      continue;
    }

    const base = schemeGuaranteedBase(parsed);
    const legalEntityId = e.defaultLegalEntityId ?? clubPrimaryLE.get(e.clubId) ?? UNASSIGNED_LE;
    if (!legalEntityId) {
      result.warnings.push({ code: "legal_entity_unknown", employeeId: e.id, employeeName: e.fullName, clubId: e.clubId, message: `Юрлицо не определено: ${e.fullName} (учтён в «Не распределено»)` });
      result.confidence = "partial";
    }
    if (base.hasVariable) {
      result.warnings.push({ code: "variable_component", employeeId: e.id, employeeName: e.fullName, clubId: e.clubId, message: `Переменная часть не прогнозируется (${base.note ?? "переменная схема"}): ${e.fullName}` });
      result.confidence = "partial";
    }

    const cat = forecastCategoryOfPosition(e.position);
    result.totalKopeks += base.baseKopeks;
    result.byClub[e.clubId] = (result.byClub[e.clubId] ?? 0) + base.baseKopeks;
    result.byCategory[cat] += base.baseKopeks;
    result.byEmployee[e.id] = base.baseKopeks;
    result.byLegalEntity[legalEntityId] = (result.byLegalEntity[legalEntityId] ?? 0) + base.baseKopeks;
    result.schemedCount += 1;
  }

  return result;
}
