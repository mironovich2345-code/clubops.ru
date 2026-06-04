"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import {
  getCurrentCompanyAndClub,
  getInvitableRoles,
  canManageClubUsers,
  userHasCompanyRole,
  recordAudit,
} from "@/lib/access";
import { generateInviteToken, inviteExpiry, isClubScopedRole } from "@/lib/invites";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Not exported: a "use server" module may only export async functions. The
// client form infers this shape from createInvite's signature.
type InviteState = {
  ok: boolean;
  error?: string;
  invitePath?: string;
};

export async function createInvite(
  _prev: InviteState | undefined,
  formData: FormData,
): Promise<InviteState> {
  const user = await requireUser();

  try {
  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) return { ok: false, error: "Нет доступной компании" };
  const companyId = scope.company.id;

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "").trim();
  const clubIdRaw = String(formData.get("clubId") ?? "").trim();

  if (!EMAIL_RE.test(email)) return { ok: false, error: "Введите корректный email" };

  // getInvitableRoles is the single source of truth for who may invite which
  // role (owner -> owner/general_director-if-none; GD -> regional/accountant/
  // manager/marketer; regional -> manager). No global User.role is trusted.
  const invitable = await getInvitableRoles(user.id, companyId);
  if (!invitable.includes(role)) {
    return { ok: false, error: "Недостаточно прав для приглашения этой роли" };
  }

  let clubId: string | null = null;
  if (isClubScopedRole(role)) {
    if (!clubIdRaw) return { ok: false, error: "Для управляющего нужно выбрать клуб" };
    const club = await prisma.club.findFirst({
      where: { id: clubIdRaw, companyId },
      select: { id: true },
    });
    if (!club) return { ok: false, error: "Клуб не найден в этой компании" };
    if (!(await canManageClubUsers(user.id, clubIdRaw))) {
      return { ok: false, error: "Нет прав управлять этим клубом" };
    }
    clubId = clubIdRaw;
  }
  // Company-level roles (owner/general_director/regional_director/accountant/
  // marketer) are already authorized by getInvitableRoles above.

  // Reject if the invited person already has the same access.
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
    if (clubId) {
      const dup = await prisma.clubUserAccess.findFirst({
        where: { clubId, userId: existingUser.id, role },
        select: { id: true },
      });
      if (dup) return { ok: false, error: "У пользователя уже есть этот доступ" };
    } else {
      const dup = await prisma.companyUserAccess.findFirst({
        where: { companyId, userId: existingUser.id, role },
        select: { id: true },
      });
      if (dup) return { ok: false, error: "У пользователя уже есть этот доступ" };
    }
  }

  // Reject a duplicate active (pending, non-expired) invite.
  const pending = await prisma.invite.findFirst({
    where: {
      email,
      companyId,
      clubId,
      role,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (pending) return { ok: false, error: "Активное приглашение уже существует" };

  const { token, tokenHash } = generateInviteToken();
  const invite = await prisma.invite.create({
    data: {
      tokenHash,
      email,
      companyId,
      clubId,
      role,
      invitedByUserId: user.id,
      expiresAt: inviteExpiry(),
    },
  });

  await recordAudit({
    action: "role.invited",
    entityType: "Invite",
    entityId: invite.id,
    companyId,
    clubId,
    userId: user.id,
    metadata: { email, role },
  });

  revalidatePath("/users");
  return { ok: true, invitePath: `/accept-invite?token=${token}` };
  } catch (error) {
    // Surface a friendly message but keep the real error in the server logs.
    console.error("createInvite failed", error);
    return { ok: false, error: "Не удалось создать приглашение. Попробуйте ещё раз." };
  }
}

export async function removeAccess(formData: FormData): Promise<void> {
  const user = await requireUser();
  const scope = String(formData.get("scope") ?? "");
  const accessId = String(formData.get("accessId") ?? "");

  if (scope === "company") {
    const row = await prisma.companyUserAccess.findUnique({ where: { id: accessId } });
    if (!row) throw new Error("Доступ не найден");
    if (row.userId === user.id) throw new Error("Нельзя удалить собственный доступ");
    const isOwner = await userHasCompanyRole(user.id, row.companyId, ["owner"]);
    const isGD = await userHasCompanyRole(user.id, row.companyId, ["general_director"]);
    if (!isOwner && !isGD) throw new Error("Недостаточно прав");
    // A general director manages operational roles but may not remove an owner
    // or another general director — that stays an owner action.
    if (!isOwner && (row.role === "owner" || row.role === "general_director")) {
      throw new Error("Только собственник может изменять доступ этого уровня");
    }
    await prisma.companyUserAccess.delete({ where: { id: accessId } });
    await recordAudit({
      action: "access.removed",
      entityType: "CompanyUserAccess",
      entityId: accessId,
      companyId: row.companyId,
      userId: user.id,
      metadata: { targetUserId: row.userId, role: row.role },
    });
  } else if (scope === "club") {
    const row = await prisma.clubUserAccess.findUnique({ where: { id: accessId } });
    if (!row) throw new Error("Доступ не найден");
    if (row.userId === user.id) throw new Error("Нельзя удалить собственный доступ");
    if (!(await canManageClubUsers(user.id, row.clubId))) {
      throw new Error("Недостаточно прав");
    }
    await prisma.clubUserAccess.delete({ where: { id: accessId } });
    await recordAudit({
      action: "access.removed",
      entityType: "ClubUserAccess",
      entityId: accessId,
      clubId: row.clubId,
      userId: user.id,
      metadata: { targetUserId: row.userId, role: row.role },
    });
  } else {
    throw new Error("Неверный тип доступа");
  }

  revalidatePath("/users");
}
