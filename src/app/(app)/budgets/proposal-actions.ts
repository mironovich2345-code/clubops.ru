"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, canAccessClub, recordAudit } from "@/lib/access";
import { isValidMonth } from "@/lib/budgets";
import {
  canProposeBudgetChange,
  canApproveBudgetChange,
  createBudgetChangeProposal,
  decideBudgetChangeProposal,
  isSyncMode,
} from "@/lib/payroll/budget-linkage";

type State = { ok: boolean; error?: string };

/** Regional/owner/GD propose a salary-budget change. Append-only; the Budget is untouched.
 * Form-facing (returns void); invalid input is ignored (no silent budget mutation). */
export async function proposeSalaryBudgetChange(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "budgets")) return;
  if (!canProposeBudgetChange(ctx.effectiveRoles)) return;

  const clubId = String(formData.get("clubId") ?? "").trim();
  const month = String(formData.get("month") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const rawAmount = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const rubles = rawAmount === "" ? NaN : Number(rawAmount);

  if (!clubId || !ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) return;
  if (!isValidMonth(month)) return;
  if (!Number.isFinite(rubles) || rubles < 0) return;
  if (!reason) return;

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  if (!club || club.companyId !== ctx.selectedCompanyId) return;

  const { id } = await createBudgetChangeProposal({
    companyId: ctx.selectedCompanyId,
    clubId,
    month,
    proposedLimitKopeks: rublesToKopeks(rubles),
    reason,
    sourceType: "manual",
    proposedByUserId: ctx.user.id,
  });
  await recordAudit({ action: "budget_change_proposal_created", entityType: "budget_change_proposal", companyId: ctx.selectedCompanyId, clubId, userId: ctx.user.id, entityId: id });
  revalidatePath("/budgets");
}

async function decide(formData: FormData, decision: "approved" | "rejected"): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "budgets")) return;
  if (!canApproveBudgetChange(ctx.effectiveRoles)) return;

  const proposalId = String(formData.get("proposalId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || undefined;
  if (!proposalId) return;

  // Scope: the proposal's club must be accessible to this actor.
  const p = await prisma.budgetChangeProposal.findUnique({ where: { id: proposalId }, select: { clubId: true, companyId: true } });
  if (!p || p.companyId !== ctx.selectedCompanyId || !ctx.allowedClubIds.includes(p.clubId) || !(await canAccessClub(ctx.user.id, p.clubId))) return;

  const res = await decideBudgetChangeProposal({ companyId: ctx.selectedCompanyId, proposalId, decision, decidedByUserId: ctx.user.id, decisionNote: note });
  if (!res.ok) return;
  await recordAudit({ action: decision === "approved" ? "budget_change_proposal_approved" : "budget_change_proposal_rejected", entityType: "budget_change_proposal", companyId: ctx.selectedCompanyId, clubId: p.clubId, userId: ctx.user.id, entityId: proposalId });
  revalidatePath("/budgets");
}

export async function approveBudgetChangeProposal(formData: FormData): Promise<void> {
  await decide(formData, "approved");
}
export async function rejectBudgetChangeProposal(formData: FormData): Promise<void> {
  await decide(formData, "rejected");
}

/** Salary-planning company settings (owner/GD only): sync mode, taxes-in-budget flag, pay
 * schedule days + weekend rule. Invalid input is ignored (defaults preserved; never faked). */
export async function updateSalaryPlanningSettings(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canApproveBudgetChange(ctx.effectiveRoles)) return; // owner/GD only

  const rawMode = String(formData.get("syncMode") ?? "").trim();
  const includesTaxes = String(formData.get("includesTaxes") ?? "") === "on";
  const advanceDay = clampDay(formData.get("advanceDay"));
  const finalDay = clampDay(formData.get("finalDay"));
  const rawWeekend = String(formData.get("weekendRule") ?? "").trim();
  const weekendRule = ["shift_earlier", "shift_later", "none"].includes(rawWeekend) ? rawWeekend : null;

  await prisma.company.update({
    where: { id: ctx.selectedCompanyId },
    data: {
      salaryBudgetSyncMode: isSyncMode(rawMode) ? rawMode : undefined,
      salaryBudgetIncludesTaxes: includesTaxes,
      payrollAdvanceDay: advanceDay,
      payrollFinalDay: finalDay,
      payrollWeekendRule: weekendRule,
    },
  });
  await recordAudit({ action: "salary_planning_settings_updated", entityType: "Company", companyId: ctx.selectedCompanyId, userId: ctx.user.id, entityId: ctx.selectedCompanyId });
  revalidatePath("/budgets");
}

function clampDay(v: FormDataEntryValue | null): number | null {
  const n = Number(String(v ?? "").trim());
  if (!Number.isFinite(n) || n < 1 || n > 28) return null; // 1..28 → valid in every month; else unset
  return Math.trunc(n);
}
