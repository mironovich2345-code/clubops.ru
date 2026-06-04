"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { getCurrentAccessContext, userHasCompanyRole, recordAudit } from "@/lib/access";

// Not exported (a "use server" module may only export async functions).
type State = { ok: boolean; error?: string };

async function requireOwnerOf(companyId: string) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "settings")) {
    return { error: "Нет доступа" as const };
  }
  if (!ctx.allowedCompanyIds.includes(companyId) || !(await userHasCompanyRole(ctx.user.id, companyId, ["owner"]))) {
    return { error: "Только владелец организации может это изменить" as const };
  }
  return { ctx };
}

export async function createCompany(
  _prev: State | undefined,
  formData: FormData,
): Promise<State> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "settings")) {
    return { ok: false, error: "Нет доступа" };
  }
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название организации" };

  // New company -> the creator becomes its owner.
  const company = await prisma.$transaction(async (tx) => {
    const c = await tx.company.create({ data: { name } });
    await tx.companyUserAccess.create({
      data: { companyId: c.id, userId: ctx.user.id, role: "owner" },
    });
    return c;
  });

  await recordAudit({
    action: "company.created",
    entityType: "Company",
    entityId: company.id,
    companyId: company.id,
    userId: ctx.user.id,
    metadata: { name },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function updateCompany(
  _prev: State | undefined,
  formData: FormData,
): Promise<State> {
  const companyId = String(formData.get("companyId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название организации" };

  const guard = await requireOwnerOf(companyId);
  if ("error" in guard) return { ok: false, error: guard.error };

  await prisma.company.update({ where: { id: companyId }, data: { name } });
  await recordAudit({
    action: "company.updated",
    entityType: "Company",
    entityId: companyId,
    companyId,
    userId: guard.ctx.user.id,
    metadata: { name },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function createClub(
  _prev: State | undefined,
  formData: FormData,
): Promise<State> {
  const companyId = String(formData.get("companyId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название клуба" };

  const guard = await requireOwnerOf(companyId);
  if ("error" in guard) return { ok: false, error: guard.error };

  const club = await prisma.$transaction(async (tx) => {
    const c = await tx.club.create({ data: { name, city: city || "—", companyId } });
    await tx.clubUserAccess.create({
      data: { clubId: c.id, userId: guard.ctx.user.id, role: "owner" },
    });
    return c;
  });

  await recordAudit({
    action: "club.created",
    entityType: "Club",
    entityId: club.id,
    companyId,
    clubId: club.id,
    userId: guard.ctx.user.id,
    metadata: { name, city: city || "—" },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function updateClub(
  _prev: State | undefined,
  formData: FormData,
): Promise<State> {
  const clubId = String(formData.get("clubId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название клуба" };

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  if (!club) return { ok: false, error: "Клуб не найден" };

  const guard = await requireOwnerOf(club.companyId);
  if ("error" in guard) return { ok: false, error: guard.error };

  await prisma.club.update({ where: { id: clubId }, data: { name, city: city || "—" } });
  await recordAudit({
    action: "club.updated",
    entityType: "Club",
    entityId: clubId,
    companyId: club.companyId,
    clubId,
    userId: guard.ctx.user.id,
    metadata: { name, city: city || "—" },
  });

  revalidatePath("/settings");
  return { ok: true };
}
