"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canManageBalances } from "@/lib/auth";
import { getCurrentAccessContext, canAccessClub, recordAudit } from "@/lib/access";
import { rublesToKopeks } from "@/lib/money";

type State = { ok: boolean; error?: string };

function parseDay(v: string): Date | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * Append a new cash-balance snapshot (never updates old rows). Owner / general
 * director / accountant only; scope-checked against companyId + allowed clubs.
 */
export async function createBalanceSnapshot(_prev: State | undefined, formData: FormData): Promise<State> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canAnyRoleAccessPage(ctx.effectiveRoles, "balances")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canManageBalances(ctx.effectiveRoles)) {
    return { ok: false, error: "Добавлять остатки может владелец, ген. директор или бухгалтер" };
  }
  const companyId = ctx.selectedCompanyId;

  // "target" encodes the (club, legal entity) pair the snapshot is for.
  const target = String(formData.get("target") ?? "").trim();
  const [clubId, legalEntityId] = target.split(":");
  if (!clubId || !legalEntityId) return { ok: false, error: "Выберите юрлицо" };
  if (!ctx.allowedClubIds.includes(clubId) || !(await canAccessClub(ctx.user.id, clubId))) {
    return { ok: false, error: "Нет доступа к выбранному клубу" };
  }
  // The entity must belong to this company and be attached to the chosen club.
  const link = await prisma.clubLegalEntity.findUnique({
    where: { clubId_legalEntityId: { clubId, legalEntityId } },
    select: { legalEntity: { select: { companyId: true } } },
  });
  if (!link || link.legalEntity.companyId !== companyId) {
    return { ok: false, error: "Юрлицо не найдено для выбранного клуба" };
  }

  const snapshotDate = parseDay(String(formData.get("date") ?? "")) ?? new Date();

  const amountRaw = String(formData.get("amount") ?? "").trim().replace(",", ".");
  const amount = amountRaw === "" ? NaN : Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "Остаток должен быть неотрицательным числом" };
  }
  const actualBalanceKopeks = rublesToKopeks(amount);

  const comment = String(formData.get("comment") ?? "").trim() || null;

  const snap = await prisma.balanceSnapshot.create({
    data: { companyId, clubId, legalEntityId, snapshotDate, actualBalanceKopeks, comment, createdById: ctx.user.id },
  });
  await recordAudit({
    action: "balance_snapshot.created",
    entityType: "BalanceSnapshot",
    entityId: snap.id,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { legalEntityId, actualBalanceKopeks },
  });

  // Refresh everything that reads the current balance.
  revalidatePath("/balances");
  revalidatePath("/payments");
  revalidatePath("/analytics");
  revalidatePath("/dashboard");
  return { ok: true };
}
