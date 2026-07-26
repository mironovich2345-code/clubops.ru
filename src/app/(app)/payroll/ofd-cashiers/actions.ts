"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, recordAudit } from "@/lib/access";
import { canManageCashierMapping } from "@/lib/payroll/access";
import { syncCashierIdentities, assignEmployeeToIdentity, excludeIdentity } from "@/lib/ofd/cashier-mapping-service";

export type CashierActionState = { ok: boolean; error?: string; notice?: string };
const fail = (e: string): CashierActionState => ({ ok: false, error: e });

async function scopeCtx() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false as const, error: "Нет доступа" };
  const companyId = ctx.selectedCompanyId;
  const clubIds = (await getUserClubs(ctx.user.id, companyId)).map((c) => c.id);
  return { ok: true as const, ctx, companyId, clubIds };
}

async function resolveIdentity(identityId: string) {
  const base = await scopeCtx();
  if (!base.ok) return base;
  const identity = await prisma.ofdCashierIdentity.findUnique({ where: { id: identityId } });
  if (!identity || identity.companyId !== base.companyId || (identity.clubId && !base.clubIds.includes(identity.clubId))) return { ok: false as const, error: "Идентификатор кассира не найден" };
  return { ...base, identity };
}

/** Rebuild identities + suggestions from receipts in scope (idempotent). */
export async function syncIdentitiesAction(_prev: CashierActionState | undefined, formData: FormData): Promise<CashierActionState> {
  const base = await scopeCtx();
  if (!base.ok) return fail(base.error);
  if (!canManageCashierMapping(base.ctx.effectiveRoles)) return fail("Недостаточно прав.");
  const club = String(formData.get("club") ?? "").trim();
  const clubIds = club && base.clubIds.includes(club) ? [club] : base.clubIds;
  const res = await syncCashierIdentities({ companyId: base.companyId, clubIds });
  try {
    await recordAudit({ action: "payroll.cashier_identities_synced", entityType: "OfdCashierIdentity", entityId: base.companyId, companyId: base.companyId, userId: base.ctx.user.id, metadata: res });
  } catch {
    /* ignore */
  }
  revalidatePath("/payroll/ofd-cashiers");
  return { ok: true, notice: `Идентификаторы: ${res.identities}; авто: ${res.suggestions}, спорных: ${res.ambiguous}, без сопоставления: ${res.unmatched}.` };
}

/** Confirm the suggested employee or manually assign one, from an effective date. */
export async function assignEmployeeAction(_prev: CashierActionState | undefined, formData: FormData): Promise<CashierActionState> {
  const scope = await resolveIdentity(String(formData.get("identityId") ?? "").trim());
  if (!scope.ok) return fail(scope.error);
  if (!canManageCashierMapping(scope.ctx.effectiveRoles)) return fail("Недостаточно прав.");
  const { identity } = scope;
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  if (!employeeId) return fail("Выберите сотрудника.");
  const employee = await prisma.clubEmployee.findUnique({ where: { id: employeeId }, select: { companyId: true, clubId: true } });
  if (!employee || employee.companyId !== scope.companyId || !scope.clubIds.includes(employee.clubId)) return fail("Сотрудник вне зоны доступа.");
  const manual = String(formData.get("manual") ?? "") === "1";
  const effRaw = String(formData.get("effectiveFrom") ?? "").trim();
  const effectiveFrom = effRaw ? new Date(`${effRaw}T00:00:00`) : identity.firstSeenAt;
  if (Number.isNaN(effectiveFrom.getTime())) return fail("Некорректная дата.");
  try {
    await prisma.$transaction(async (tx) => {
      await assignEmployeeToIdentity(tx, { identity, employeeId, clubId: employee.clubId, legalEntityId: identity.legalEntityId, status: manual ? "manually_assigned" : "confirmed", matchMethod: manual ? "manual" : "exact_normalized_name", effectiveFrom, confirmedById: scope.ctx.user.id, comment: String(formData.get("comment") ?? "").trim() || null });
      await tx.ofdCashierIdentity.update({ where: { id: identity.id }, data: { status: "active" } });
    });
  } catch (e) {
    return fail((e as Error).message);
  }
  try {
    await recordAudit({ action: "payroll.cashier_mapping_confirmed", entityType: "OfdCashierIdentity", entityId: identity.id, companyId: scope.companyId, clubId: employee.clubId, userId: scope.ctx.user.id, metadata: { employeeId, manual } });
  } catch {
    /* ignore */
  }
  revalidatePath("/payroll/ofd-cashiers");
  revalidatePath(`/payroll/ofd-cashiers/${identity.id}`);
  return { ok: true, notice: "Сопоставление сохранено." };
}

/** Exclude an identity from attribution (kept in history). */
export async function excludeIdentityAction(_prev: CashierActionState | undefined, formData: FormData): Promise<CashierActionState> {
  const scope = await resolveIdentity(String(formData.get("identityId") ?? "").trim());
  if (!scope.ok) return fail(scope.error);
  if (!canManageCashierMapping(scope.ctx.effectiveRoles)) return fail("Недостаточно прав.");
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 3) return fail("Укажите причину исключения.");
  await prisma.$transaction(async (tx) => {
    await excludeIdentity(tx, scope.identity.id, reason, scope.ctx.user.id);
  });
  try {
    await recordAudit({ action: "payroll.cashier_identity_excluded", entityType: "OfdCashierIdentity", entityId: scope.identity.id, companyId: scope.companyId, clubId: scope.identity.clubId ?? undefined, userId: scope.ctx.user.id });
  } catch {
    /* ignore */
  }
  revalidatePath("/payroll/ofd-cashiers");
  revalidatePath(`/payroll/ofd-cashiers/${scope.identity.id}`);
  return { ok: true, notice: "Кассир исключён из распределения." };
}
