// WAVE 2 — Salary budget ↔ forecast linkage. The forecast NEVER silently overwrites the
// budget (spec §6). We only DISPLAY the relationship (forecast vs budget vs accrued vs paid
// vs remaining) and, depending on the company's salaryBudgetSyncMode, raise an append-only
// BudgetChangeProposal that a human approver accepts. "auto_sync" applies only when explicitly
// configured. All money is integer kopeks.

import { prisma } from "@/lib/prisma";
import type { Role } from "@/lib/auth";
import { calculatePayrollForecast } from "@/lib/payroll/forecast";

export const SALARY_BUDGET_CATEGORY = "salary";

export const SALARY_BUDGET_SYNC_MODES = ["manual", "suggested", "auto_sync"] as const;
export type SalaryBudgetSyncMode = (typeof SALARY_BUDGET_SYNC_MODES)[number];
export function isSyncMode(v: string): v is SalaryBudgetSyncMode {
  return (SALARY_BUDGET_SYNC_MODES as readonly string[]).includes(v);
}
export const SALARY_BUDGET_SYNC_MODE_LABELS: Record<SalaryBudgetSyncMode, string> = {
  manual: "Вручную (без предложений)",
  suggested: "Предлагать изменение (по умолчанию)",
  auto_sync: "Автосинхронизация (только при явном включении)",
};

// --- Variance (pure) --------------------------------------------------------

export type BudgetVariance = { varianceKopeks: number; variancePercent: number | null };

/**
 * budgetVariance = budget − forecast. Positive → budget covers the forecast (запас);
 * negative → forecast exceeds the budget (риск перерасхода). variancePercent is relative to
 * the forecast and is `null` (not 0) when the forecast is ≤ 0 — we never divide by an unknown
 * base or imply "0% deviation" when there is nothing to compare against (spec §13).
 */
export function computeSalaryBudgetVariance(budgetKopeks: number, forecastKopeks: number): BudgetVariance {
  const varianceKopeks = budgetKopeks - forecastKopeks;
  const variancePercent = forecastKopeks > 0 ? (varianceKopeks / forecastKopeks) * 100 : null;
  return { varianceKopeks, variancePercent };
}

// --- Sync-mode decision (pure) ---------------------------------------------

// A drift proposal is raised only in "suggested"/"auto_sync" and only when the forecast is
// known (>0) and deviates beyond the threshold. "manual" never proposes. This is the ONLY
// place drift → proposal is decided, so the no-silent-overwrite rule can't be bypassed.
export const DEFAULT_DRIFT_THRESHOLD_PERCENT = 5;

export function shouldProposeFromDrift(
  mode: SalaryBudgetSyncMode,
  variance: BudgetVariance,
  thresholdPercent: number = DEFAULT_DRIFT_THRESHOLD_PERCENT,
): boolean {
  if (mode === "manual") return false;
  if (variance.variancePercent == null) return false; // forecast unknown → never propose
  return Math.abs(variance.variancePercent) >= thresholdPercent;
}

// --- RBAC (pure) ------------------------------------------------------------

/** Who may PROPOSE a salary-budget change: regional director + owner + GD (spec §8). */
export function canProposeBudgetChange(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "regional_director" || r === "owner" || r === "general_director");
}

/** Who may APPROVE/REJECT a proposal: owner + GD only. Do NOT widen (spec §8). */
export function canApproveBudgetChange(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "owner" || r === "general_director");
}

// --- Read model: the labelled 5-number line per club -----------------------

export type SalaryBudgetLine = {
  clubId: string;
  forecastKopeks: number; // A — планируемый ФОТ
  budgetKopeks: number; // B — утверждённый бюджет ЗП
  accruedKopeks: number; // C — начислено
  paidKopeks: number; // D — выплачено
  remainingKopeks: number; // R — к выплате
  variance: BudgetVariance;
  forecastConfidence: "complete" | "partial";
};

/**
 * Load the five distinct numbers for salary per club for a month, plus variance. Read-only;
 * touches nothing. accrued/paid/remaining come from the month's PayrollCalculation rows
 * (the accrual/payment truth); forecast from active schemes; budget from Budget{category:salary}.
 */
export async function loadSalaryBudgetLines(args: {
  companyId: string;
  clubIds: string[];
  month: string; // "YYYY-MM"
  atDate: Date;
}): Promise<SalaryBudgetLine[]> {
  const { companyId, clubIds, month, atDate } = args;
  if (clubIds.length === 0) return [];
  const [yStr, mStr] = month.split("-");
  const year = Number(yStr);
  const monthNum = Number(mStr);

  const [budgets, periods, forecast] = await Promise.all([
    prisma.budget.findMany({ where: { companyId, clubId: { in: clubIds }, category: SALARY_BUDGET_CATEGORY, month }, select: { clubId: true, limitAmountKopeks: true } }),
    prisma.payrollPeriod.findMany({ where: { companyId, clubId: { in: clubIds }, year, month: monthNum }, select: { id: true, clubId: true } }),
    calculatePayrollForecast({ companyId, clubIds, atDate }),
  ]);

  const budgetByClub = new Map(budgets.map((b) => [b.clubId, b.limitAmountKopeks]));
  const periodIdByClub = new Map(periods.map((p) => [p.id, p.clubId]));

  // Accrual/payment aggregates per period → rolled to club.
  const accruedByClub = new Map<string, { accrued: number; paid: number; remaining: number }>();
  if (periods.length > 0) {
    const grouped = await prisma.payrollCalculation.groupBy({
      by: ["payrollPeriodId"],
      where: { payrollPeriodId: { in: periods.map((p) => p.id) } },
      _sum: { grossAccruedKopeks: true, paidKopeks: true, remainingKopeks: true },
    });
    for (const g of grouped) {
      const clubId = periodIdByClub.get(g.payrollPeriodId);
      if (!clubId) continue;
      const cur = accruedByClub.get(clubId) ?? { accrued: 0, paid: 0, remaining: 0 };
      cur.accrued += g._sum.grossAccruedKopeks ?? 0;
      cur.paid += g._sum.paidKopeks ?? 0;
      cur.remaining += g._sum.remainingKopeks ?? 0;
      accruedByClub.set(clubId, cur);
    }
  }

  return clubIds.map((clubId) => {
    const budgetKopeks = budgetByClub.get(clubId) ?? 0;
    const forecastKopeks = forecast.byClub[clubId] ?? 0;
    const acc = accruedByClub.get(clubId) ?? { accrued: 0, paid: 0, remaining: 0 };
    return {
      clubId,
      forecastKopeks,
      budgetKopeks,
      accruedKopeks: acc.accrued,
      paidKopeks: acc.paid,
      remainingKopeks: acc.remaining,
      variance: computeSalaryBudgetVariance(budgetKopeks, forecastKopeks),
      forecastConfidence: forecast.confidence,
    };
  });
}

// --- Proposal core (append-only) -------------------------------------------

export type ProposalSource = "forecast_drift" | "manual" | "scheme_change";

/**
 * Create an append-only BudgetChangeProposal. Does NOT touch the Budget — approval does.
 * Caller must have passed canProposeBudgetChange. Returns the created row id.
 */
export async function createBudgetChangeProposal(args: {
  companyId: string;
  clubId: string;
  month: string;
  proposedLimitKopeks: number;
  reason: string;
  sourceType: ProposalSource;
  proposedByUserId: string;
  forecastKopeks?: number;
}): Promise<{ id: string }> {
  const current = await prisma.budget.findFirst({
    where: { clubId: args.clubId, category: SALARY_BUDGET_CATEGORY, month: args.month },
    select: { limitAmountKopeks: true },
  });
  const row = await prisma.budgetChangeProposal.create({
    data: {
      companyId: args.companyId,
      clubId: args.clubId,
      category: SALARY_BUDGET_CATEGORY,
      month: args.month,
      currentLimitKopeks: current?.limitAmountKopeks ?? 0,
      proposedLimitKopeks: args.proposedLimitKopeks,
      forecastKopeks: args.forecastKopeks ?? null,
      reason: args.reason,
      sourceType: args.sourceType,
      status: "pending",
      proposedByUserId: args.proposedByUserId,
    },
    select: { id: true },
  });
  return row;
}

/**
 * Approve/reject a proposal. On approval the Budget is upserted to the proposed limit — the
 * ONLY path that mutates a salary Budget from a proposal (spec §6). Append-only: the proposal
 * flips status, it is never deleted. Caller must have passed canApproveBudgetChange.
 */
export async function decideBudgetChangeProposal(args: {
  companyId: string;
  proposalId: string;
  decision: "approved" | "rejected";
  decidedByUserId: string;
  decisionNote?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const p = await prisma.budgetChangeProposal.findUnique({ where: { id: args.proposalId } });
  if (!p || p.companyId !== args.companyId) return { ok: false, error: "Предложение не найдено." };
  if (p.status !== "pending") return { ok: false, error: "Предложение уже обработано." };

  if (args.decision === "rejected") {
    await prisma.budgetChangeProposal.update({
      where: { id: p.id },
      data: { status: "rejected", decidedByUserId: args.decidedByUserId, decidedAt: new Date(), decisionNote: args.decisionNote ?? null },
    });
    return { ok: true };
  }

  // Approved → upsert the Budget, then record the applied link.
  const budget = await prisma.budget.upsert({
    where: { clubId_category_month: { clubId: p.clubId, category: SALARY_BUDGET_CATEGORY, month: p.month } },
    update: { limitAmountKopeks: p.proposedLimitKopeks },
    create: { companyId: p.companyId, clubId: p.clubId, category: SALARY_BUDGET_CATEGORY, month: p.month, limitAmountKopeks: p.proposedLimitKopeks, createdByUserId: args.decidedByUserId },
    select: { id: true },
  });
  await prisma.budgetChangeProposal.update({
    where: { id: p.id },
    data: { status: "approved", decidedByUserId: args.decidedByUserId, decidedAt: new Date(), decisionNote: args.decisionNote ?? null, appliedBudgetId: budget.id },
  });
  return { ok: true };
}
