"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, canAccessClub, recordAudit } from "@/lib/access";
import { monthClosedError } from "@/lib/month-close";
import { rublesToKopeks } from "@/lib/money";
import { resolveActiveIpForClub } from "@/lib/expense-simplified";
import { ensureClubCashWallet, ensureRegionalCashWallet } from "@/lib/cash-wallets";
import { postCashOutflow, postCashInflow } from "@/lib/payroll/payments";
import { applySettlement, canSettleObligation, canWriteOffObligation } from "@/lib/payroll/obligations";

export type ObligationState = { ok: boolean; error?: string };
const fail = (error: string): ObligationState => ({ ok: false, error });

async function scopeObligation(obligationId: string) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false as const, error: "Нет доступа" };
  const companyId = ctx.selectedCompanyId;
  const clubIds = (await getUserClubs(ctx.user.id, companyId)).map((c) => c.id);
  const obligation = await prisma.employeeFinancialObligation.findUnique({ where: { id: obligationId } });
  if (!obligation || obligation.companyId !== companyId) return { ok: false as const, error: "Обязательство не найдено" };
  if (!obligation.clubId || !clubIds.includes(obligation.clubId) || !(await canAccessClub(ctx.user.id, obligation.clubId))) {
    return { ok: false as const, error: "Нет доступа к клубу обязательства" };
  }
  return { ok: true as const, ctx, companyId, obligation, clubId: obligation.clubId };
}

/**
 * Record a settlement against a SPECIFIC obligation (never a faceless income/expense).
 * Cash direction follows the debt: an employee repaying (employee_owes_company) is a
 * cash INFLOW to the wallet; the company paying a remainder (company_owes_employee) is
 * a cash OUTFLOW. Bank settlements do not touch a wallet.
 */
export async function settleObligation(
  _prev: ObligationState | undefined,
  formData: FormData,
): Promise<ObligationState> {
  const obligationId = String(formData.get("obligationId") ?? "").trim();
  const scope = await scopeObligation(obligationId);
  if (!scope.ok) return fail(scope.error);
  if (!canSettleObligation(scope.ctx.effectiveRoles)) return fail("Недостаточно прав для погашения");
  const { obligation, clubId } = scope;
  if (obligation.status !== "open" && obligation.status !== "partially_settled") return fail("Обязательство уже закрыто");

  const method = String(formData.get("method") ?? "").trim();
  if (method !== "cash" && method !== "bank") return fail("Выберите способ");
  const raw = String(formData.get("amount") ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const amountKopeks = raw === "" ? 0 : rublesToKopeks(Number(raw));
  if (!Number.isFinite(amountKopeks) || amountKopeks <= 0) return fail("Сумма должна быть больше нуля");
  if (amountKopeks > obligation.outstandingAmountKopeks) return fail("Сумма превышает остаток долга");

  const now = new Date();
  const closed = await monthClosedError(scope.companyId, clubId, now);
  if (closed) return fail(closed);

  const settlement = applySettlement(obligation.outstandingAmountKopeks, amountKopeks);

  if (method === "cash") {
    const ip = await resolveActiveIpForClub(clubId);
    if (!ip.ok) return fail(ip.error);
    const walletId = scope.ctx.effectiveRoles.includes("regional_director")
      ? await ensureRegionalCashWallet(scope.companyId, clubId, ip.legalEntityId, scope.ctx.user.id)
      : await ensureClubCashWallet(scope.companyId, clubId, ip.legalEntityId);
    const sourceId = `${obligation.id}:${now.getTime()}`;
    const common = {
      companyId: scope.companyId,
      clubId,
      legalEntityId: ip.legalEntityId,
      walletId,
      amountKopeks: settlement.appliedKopeks,
      occurredAt: now,
      userId: scope.ctx.user.id,
    };
    if (obligation.direction === "employee_owes_company") {
      // employee returns cash → INFLOW
      await postCashInflow({ ...common, sourceType: "payroll_obligation_in", sourceId, comment: "Погашение долга сотрудника" });
    } else {
      // company pays the remainder → OUTFLOW
      await postCashOutflow({ ...common, sourceType: "payroll_obligation_out", sourceId, comment: "Выплата остатка сотруднику" });
    }
  }

  await prisma.employeeFinancialObligation.update({
    where: { id: obligation.id },
    data: {
      outstandingAmountKopeks: settlement.newOutstandingKopeks,
      status: settlement.status,
      closedAt: settlement.status === "settled" ? now : null,
    },
  });
  try {
    await recordAudit({
      action: "payroll.obligation_settled",
      entityType: "EmployeeFinancialObligation",
      entityId: obligation.id,
      companyId: scope.companyId,
      clubId,
      userId: scope.ctx.user.id,
      metadata: { method, appliedKopeks: settlement.appliedKopeks, direction: obligation.direction },
    });
  } catch {
    /* ignore */
  }
  revalidatePath("/payroll/obligations");
  return { ok: true };
}

/**
 * Write off a debt — the ONLY way an obligation disappears without a settlement. Never
 * automatic (a dismissed employee's debt survives dismissal, spec §7). Owner / chief
 * accountant only; comment required.
 */
export async function writeOffObligation(
  _prev: ObligationState | undefined,
  formData: FormData,
): Promise<ObligationState> {
  const obligationId = String(formData.get("obligationId") ?? "").trim();
  const scope = await scopeObligation(obligationId);
  if (!scope.ok) return fail(scope.error);
  if (!canWriteOffObligation(scope.ctx.effectiveRoles)) return fail("Списание доступно только собственнику или главному бухгалтеру");
  if (scope.obligation.status !== "open" && scope.obligation.status !== "partially_settled") return fail("Обязательство уже закрыто");
  const comment = String(formData.get("comment") ?? "").trim();
  if (!comment) return fail("Укажите причину списания");

  await prisma.employeeFinancialObligation.update({
    where: { id: scope.obligation.id },
    data: { status: "written_off", outstandingAmountKopeks: 0, closedAt: new Date() },
  });
  try {
    await recordAudit({
      action: "payroll.obligation_written_off",
      entityType: "EmployeeFinancialObligation",
      entityId: scope.obligation.id,
      companyId: scope.companyId,
      clubId: scope.clubId,
      userId: scope.ctx.user.id,
      metadata: { comment, outstandingBefore: scope.obligation.outstandingAmountKopeks },
    });
  } catch {
    /* ignore */
  }
  revalidatePath("/payroll/obligations");
  return { ok: true };
}
