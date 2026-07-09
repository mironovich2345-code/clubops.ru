"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getCurrentCompanyAndClub, userHasCompanyRole, rawRolesInCompany, recordAudit } from "@/lib/access";
import { isSystemAdminRole } from "@/lib/system-role";
import { classifyRoleShape, canPromoteToRegional, canDemoteToManager, normalizeSelectedClubIds } from "@/lib/employee-roles";

type RoleState = { ok: boolean; error?: string };

const NOT_GD = "У вас нет права изменять роль этого сотрудника.";
const ALREADY_CHANGED = "Роль сотрудника уже изменена.";
const CLUB_GONE = "Клуб больше недоступен.";

/** Resolve the acting general_director + their company. Returns null on failure. */
async function requireGeneralDirector(): Promise<{ actorId: string; companyId: string } | null> {
  const actor = await requireUser();
  const scope = await getCurrentCompanyAndClub(actor);
  if (!scope.company) return null;
  if (!(await userHasCompanyRole(actor.id, scope.company.id, ["general_director"]))) return null;
  return { actorId: actor.id, companyId: scope.company.id };
}

/** Active clubs of `companyId` among the given ids (server-validated — client ids
 * are never trusted). Returns the matched active club ids. */
async function validActiveClubIds(companyId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.club.findMany({
    where: { id: { in: ids }, companyId, isActive: true },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

async function loadTarget(targetUserId: string, companyId: string) {
  const user = await prisma.user.findUnique({ where: { id: targetUserId }, select: { isActive: true, deletedAt: true, systemRole: true } });
  if (!user || user.deletedAt || !user.isActive) return null;
  const roles = await rawRolesInCompany(targetUserId, companyId);
  return { user, roles: [...roles], shape: classifyRoleShape([...roles], isSystemAdminRole(user.systemRole)) };
}

// ============================ Promote → regional ============================

/** general_director promotes a company manager to regional_director for the
 * SELECTED active clubs (>=1). Manager access in this company is removed. */
export async function promoteToRegional(_prev: RoleState | undefined, formData: FormData): Promise<RoleState> {
  const gd = await requireGeneralDirector();
  if (!gd) return { ok: false, error: NOT_GD };

  const targetUserId = String(formData.get("userId") ?? "").trim();
  if (!targetUserId || targetUserId === gd.actorId) return { ok: false, error: NOT_GD };

  const selected = normalizeSelectedClubIds(formData.getAll("clubIds").map((v) => String(v)));
  if (selected.length === 0) return { ok: false, error: "Выберите хотя бы один клуб." };

  const target = await loadTarget(targetUserId, gd.companyId);
  if (!target) return { ok: false, error: "Сотрудник не входит в вашу организацию." };
  const eligible = canPromoteToRegional(target.shape);
  if (!eligible.ok) {
    if (target.shape === "mixed") console.warn("role.promote.mixed_state", JSON.stringify({ targetUserId, companyId: gd.companyId }));
    return { ok: false, error: eligible.error };
  }

  const validClubs = await validActiveClubIds(gd.companyId, selected);
  if (validClubs.length !== selected.length || validClubs.length === 0) return { ok: false, error: CLUB_GONE };

  try {
    await prisma.$transaction(async (tx) => {
      // Re-check role state atomically (concurrent promote/demote).
      const roles = await rawRolesInCompany(targetUserId, gd.companyId);
      if (classifyRoleShape([...roles], isSystemAdminRole(target.user.systemRole)) !== "manager") throw new Error("STALE_ROLE");
      // Re-validate clubs still active inside the transaction (archive race).
      const stillActive = await tx.club.findMany({ where: { id: { in: validClubs }, companyId: gd.companyId, isActive: true }, select: { id: true } });
      if (stillActive.length !== validClubs.length) throw new Error("CLUB_GONE");

      // Remove ALL manager access in THIS company (club-level + any company-level).
      await tx.clubUserAccess.deleteMany({ where: { userId: targetUserId, role: "manager", club: { companyId: gd.companyId } } });
      await tx.companyUserAccess.deleteMany({ where: { userId: targetUserId, role: "manager", companyId: gd.companyId } });
      // Grant regional_director on the selected clubs.
      await tx.clubUserAccess.createMany({ data: validClubs.map((clubId) => ({ clubId, userId: targetUserId, role: "regional_director" })) });
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "STALE_ROLE") return { ok: false, error: ALREADY_CHANGED };
    if (msg === "CLUB_GONE") return { ok: false, error: CLUB_GONE };
    return { ok: false, error: "Не удалось изменить роль. Обновите страницу." };
  }

  await recordAudit({
    action: "employee.promoted_to_regional", entityType: "User", entityId: targetUserId, userId: gd.actorId,
    companyId: gd.companyId, metadata: { previousRole: "manager", newRole: "regional_director", selectedClubIds: validClubs },
  });
  revalidatePath("/users");
  revalidatePath("/", "layout");
  return { ok: true };
}

// ============================ Demote → manager ==============================

/** general_director demotes a regional_director to manager of exactly ONE selected
 * active club. All regional access in this company is removed. */
export async function demoteToManager(_prev: RoleState | undefined, formData: FormData): Promise<RoleState> {
  const gd = await requireGeneralDirector();
  if (!gd) return { ok: false, error: NOT_GD };

  const targetUserId = String(formData.get("userId") ?? "").trim();
  if (!targetUserId || targetUserId === gd.actorId) return { ok: false, error: NOT_GD };

  // Exactly one club — reject a multi-value payload injection.
  const selected = normalizeSelectedClubIds(formData.getAll("clubIds").map((v) => String(v)));
  if (selected.length !== 1) return { ok: false, error: "Выберите клуб для управляющего." };
  const clubId = selected[0];

  const target = await loadTarget(targetUserId, gd.companyId);
  if (!target) return { ok: false, error: "Сотрудник не входит в вашу организацию." };
  const eligible = canDemoteToManager(target.shape);
  if (!eligible.ok) {
    if (target.shape === "mixed") console.warn("role.demote.mixed_state", JSON.stringify({ targetUserId, companyId: gd.companyId }));
    return { ok: false, error: eligible.error };
  }

  const validClubs = await validActiveClubIds(gd.companyId, [clubId]);
  if (validClubs.length !== 1) return { ok: false, error: CLUB_GONE };

  try {
    await prisma.$transaction(async (tx) => {
      const roles = await rawRolesInCompany(targetUserId, gd.companyId);
      if (classifyRoleShape([...roles], isSystemAdminRole(target.user.systemRole)) !== "regional") throw new Error("STALE_ROLE");
      const stillActive = await tx.club.findFirst({ where: { id: clubId, companyId: gd.companyId, isActive: true }, select: { id: true } });
      if (!stillActive) throw new Error("CLUB_GONE");

      // Remove ALL regional_director access in THIS company (club + company level).
      await tx.clubUserAccess.deleteMany({ where: { userId: targetUserId, role: "regional_director", club: { companyId: gd.companyId } } });
      await tx.companyUserAccess.deleteMany({ where: { userId: targetUserId, role: "regional_director", companyId: gd.companyId } });
      // Grant manager on exactly the one selected club.
      await tx.clubUserAccess.createMany({ data: [{ clubId, userId: targetUserId, role: "manager" }] });
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "STALE_ROLE") return { ok: false, error: ALREADY_CHANGED };
    if (msg === "CLUB_GONE") return { ok: false, error: CLUB_GONE };
    return { ok: false, error: "Не удалось изменить роль. Обновите страницу." };
  }

  await recordAudit({
    action: "employee.demoted_to_manager", entityType: "User", entityId: targetUserId, userId: gd.actorId,
    companyId: gd.companyId, metadata: { previousRole: "regional_director", newRole: "manager", selectedClubIds: [clubId] },
  });
  revalidatePath("/users");
  revalidatePath("/", "layout");
  return { ok: true };
}
