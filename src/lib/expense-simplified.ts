// Simplified cash-expense workflow (entryVersion=2): status machine, realized-
// status set, centralized business-date rules, active-ИП resolution and
// budget-overrun routing. Money is integer kopeks; percentages are basis points
// (never float money). Server-only.
import { prisma } from "@/lib/prisma";
import { computeUsedKopeks, EXPENSE_REALIZED_STATUSES } from "@/lib/budgets";
import { getActiveClubLegalEntity } from "@/lib/legal-entities";

export { EXPENSE_REALIZED_STATUSES };

// --- Status machine --------------------------------------------------------
export const EXP = {
  DRAFT: "draft",
  SUBMITTED: "submitted",
  PENDING_REGIONAL: "pending_regional_budget_approval",
  PENDING_OWNER: "pending_owner_budget_approval",
  PENDING_ACCOUNTANT: "pending_accountant_verification",
  NEEDS_CORRECTION: "needs_correction",
  VERIFIED: "verified",
  CANCELLED: "cancelled",
} as const;

export const V2_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик",
  submitted: "Отправлен",
  pending_regional_budget_approval: "Ожидает согласования РД (бюджет)",
  pending_owner_budget_approval: "Ожидает согласования собственника (бюджет)",
  pending_accountant_verification: "Ожидает проверки бухгалтерии",
  needs_correction: "Требует исправления",
  verified: "Проверен",
  cancelled: "Отменён",
};

// v2 statuses a manager may still edit (documents, fields, date).
export const V2_EDITABLE_STATUSES = ["draft", "needs_correction"] as const;
export const V2_CANCELABLE_STATUSES = [
  "draft", "submitted", "pending_regional_budget_approval",
  "pending_owner_budget_approval", "pending_accountant_verification", "needs_correction",
] as const;

// --- Business date rules (Part 14) -----------------------------------------
// Single source of truth. Uses server-local calendar days as the deployment
// business timezone (consistent with the existing month-range logic), so an
// expense never shifts across a day/month boundary via raw UTC comparison.
export const EXPENSE_MAX_PAST_DAYS = 7;

export function startOfBusinessDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function diffCalendarDays(a: Date, b: Date): number {
  return Math.round((startOfBusinessDay(a).getTime() - startOfBusinessDay(b).getTime()) / 86_400_000);
}

export type DateCheck = { ok: true } | { ok: false; error: string };

/** Validate a manager-entered expense date against future + 7-day-past rules. */
export function validateExpenseBusinessDate(expenseDate: Date, now: Date = new Date()): DateCheck {
  const dayDelta = diffCalendarDays(now, expenseDate); // >0 = past, <0 = future
  if (dayDelta < 0) return { ok: false, error: "Дата не может быть в будущем." };
  if (dayDelta > EXPENSE_MAX_PAST_DAYS) return { ok: false, error: `Дата не может быть раньше, чем ${EXPENSE_MAX_PAST_DAYS} дней назад.` };
  return { ok: true };
}

/** True while a regional director may still correct the date (7 days from save). */
export function withinRegionalDateEditWindow(firstSavedAt: Date, now: Date = new Date()): boolean {
  return diffCalendarDays(now, firstSavedAt) <= EXPENSE_MAX_PAST_DAYS;
}

// --- Active ИП resolution (Part 6) -----------------------------------------
export type IpResolution =
  | { ok: true; legalEntityId: string }
  | { ok: false; error: string };

/** The Club's single active ИП, or a clear configuration error. Never guesses. */
export async function resolveActiveIpForClub(clubId: string): Promise<IpResolution> {
  const active = await prisma.clubLegalEntity.findMany({
    where: { clubId, isActive: true, legalEntity: { isActive: true, type: { in: ["ip", "ИП"] } } },
    select: { legalEntityId: true },
  });
  if (active.length === 0) return { ok: false, error: "У клуба не назначено активное ИП. Обратитесь к администратору." };
  if (active.length > 1) return { ok: false, error: "У клуба несколько активных ИП. Обратитесь к администратору." };
  // Reuse the centralized resolver for the definitive single active ИП.
  const ip = await getActiveClubLegalEntity(clubId, "ip");
  if (!ip) return { ok: false, error: "Активное ИП клуба не найдено." };
  return { ok: true, legalEntityId: ip.id };
}

// --- Budget-overrun routing (Part 12) --------------------------------------
export type BudgetRoute = {
  level: "within" | "regional" | "owner";
  overrunKopeks: number;
  overrunBasisPoints: number; // 500 = 5%; 10000 = 100%
  limitKopeks: number;
  projectedUsageKopeks: number;
  nextStatus: string; // PENDING_ACCOUNTANT | PENDING_REGIONAL | PENDING_OWNER
};

const FIVE_PERCENT_BP = 500;

function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Route a specific expense by its budget impact. Reuses the CENTRAL budget-usage
 * calculation (computeUsedKopeks — same status constants as budgets/analytics)
 * and counts THIS expense once: projected = currentUsage + amount − alreadyCounted.
 *  - no overrun            → accounting verification;
 *  - overrun 0<bp<=500     → regional approval;
 *  - overrun bp>500        → owner approval;
 *  - missing/zero budget with a positive amount → owner exception (never "within").
 */
export async function routeExpenseBudget(opts: {
  clubId: string; category: string; expenseDate: Date; amountKopeks: number; alreadyCountedKopeks?: number;
}): Promise<BudgetRoute> {
  const { clubId, category, expenseDate, amountKopeks } = opts;
  const alreadyCounted = opts.alreadyCountedKopeks ?? 0;
  const month = monthKeyOf(expenseDate);

  const budget = await prisma.budget.findFirst({ where: { clubId, category, month }, select: { limitAmountKopeks: true } });
  const limitKopeks = budget?.limitAmountKopeks ?? 0;
  const currentUsage = await computeUsedKopeks(clubId, category, month);
  const projectedUsageKopeks = Math.max(0, currentUsage + amountKopeks - alreadyCounted);

  // Missing/zero budget with a positive amount is NOT "within budget" — it
  // requires an explicit owner-level exception.
  if (limitKopeks <= 0) {
    const isOverrun = amountKopeks > 0;
    return {
      level: isOverrun ? "owner" : "within",
      overrunKopeks: isOverrun ? projectedUsageKopeks : 0,
      overrunBasisPoints: isOverrun ? 10000 : 0,
      limitKopeks,
      projectedUsageKopeks,
      nextStatus: isOverrun ? EXP.PENDING_OWNER : EXP.PENDING_ACCOUNTANT,
    };
  }

  const overrunKopeks = Math.max(0, projectedUsageKopeks - limitKopeks);
  // Basis points = overrun/limit * 10000, integer-safe (round half up).
  const overrunBasisPoints = overrunKopeks === 0 ? 0 : Math.round((overrunKopeks * 10000) / limitKopeks);

  let level: BudgetRoute["level"];
  let nextStatus: string;
  if (overrunKopeks === 0) { level = "within"; nextStatus = EXP.PENDING_ACCOUNTANT; }
  else if (overrunBasisPoints <= FIVE_PERCENT_BP) { level = "regional"; nextStatus = EXP.PENDING_REGIONAL; }
  else { level = "owner"; nextStatus = EXP.PENDING_OWNER; }

  return { level, overrunKopeks, overrunBasisPoints, limitKopeks, projectedUsageKopeks, nextStatus };
}

// --- Money parsing (Part 3) ------------------------------------------------
/** Parse a Russian ruble string ("1 234,56" / "1234.5") to integer kopeks. */
export function parseRublesToKopeks(raw: string): { ok: true; kopeks: number } | { ok: false } {
  const cleaned = String(raw ?? "").replace(/\s| /g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false };
  const kopeks = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(kopeks) || kopeks <= 0) return { ok: false };
  return { ok: true, kopeks };
}

// --- Centralized status-machine guards (Part 16) ---------------------------
// One authoritative source. Every mutation action calls these; unknown statuses
// fail closed. Guards are PURE predicates on (expense, actor) — the action
// builds the actor from the server access context (never client input).
import type { Role } from "@/lib/auth";

export type ExpenseActor = {
  userId: string;
  roles: readonly Role[];
  allowedClubIds: readonly string[];
  companyOwner: boolean; // owner of the expense's company
  regionalForClub: boolean; // regional director whose scope includes the club
  accountant: boolean; // accountant OR chief_accountant in scope
  manager: boolean; // create-capable operational role (manager/regional)
};

type ExpenseLike = { entryVersion: number; status: string; clubId: string; firstSavedAt: Date | null };

const inScope = (a: ExpenseActor, e: ExpenseLike) => a.allowedClubIds.includes(e.clubId);
const isV2 = (e: ExpenseLike) => e.entryVersion === 2;

export function canEditExpense(e: ExpenseLike, a: ExpenseActor): boolean {
  return isV2(e) && (V2_EDITABLE_STATUSES as readonly string[]).includes(e.status) && a.manager && inScope(a, e);
}
export function canSubmitExpense(e: ExpenseLike, a: ExpenseActor): boolean {
  return canEditExpense(e, a); // document-count check happens in the action
}
export function canApproveRegionalExpense(e: ExpenseLike, a: ExpenseActor): boolean {
  return isV2(e) && e.status === EXP.PENDING_REGIONAL && a.regionalForClub;
}
export function canApproveOwnerExpense(e: ExpenseLike, a: ExpenseActor): boolean {
  return isV2(e) && e.status === EXP.PENDING_OWNER && a.companyOwner;
}
export function canVerifyExpense(e: ExpenseLike, a: ExpenseActor): boolean {
  return isV2(e) && e.status === EXP.PENDING_ACCOUNTANT && a.accountant && inScope(a, e);
}
export function canReturnExpenseForCorrection(e: ExpenseLike, a: ExpenseActor): boolean {
  if (!isV2(e)) return false;
  if (e.status === EXP.PENDING_REGIONAL) return a.regionalForClub;
  if (e.status === EXP.PENDING_OWNER) return a.companyOwner;
  if (e.status === EXP.PENDING_ACCOUNTANT) return a.accountant && inScope(a, e);
  return false;
}
export function canCancelExpense(e: ExpenseLike, a: ExpenseActor): boolean {
  if (!isV2(e)) return false;
  if (!(V2_CANCELABLE_STATUSES as readonly string[]).includes(e.status)) return false; // excludes verified/cancelled
  return (a.manager && inScope(a, e)) || a.regionalForClub;
}
export function canChangeExpenseDate(e: ExpenseLike, a: ExpenseActor): boolean {
  if (!isV2(e) || !a.regionalForClub) return false;
  if (e.status === EXP.VERIFIED || e.status === EXP.CANCELLED) return false;
  return e.firstSavedAt ? withinRegionalDateEditWindow(e.firstSavedAt) : true;
}
