"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import {
  getCurrentCompanyAndClub,
  getInvitableRoles,
  canManageClubUsers,
  userHasCompanyRole,
  assertCanManageUser,
  isLastActiveOwner,
  recordAudit,
} from "@/lib/access";
import { revokeAllSessionsForUser } from "@/lib/session";
import { getAppUrlSafe } from "@/lib/app-url";
import { generateInviteToken, inviteExpiry, isClubScopedRole } from "@/lib/invites";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Not exported: a "use server" module may only export async functions. The
// client form infers this shape from createInvite's signature.
type InviteState = {
  ok: boolean;
  error?: string;
  invitePath?: string;
  // Absolute link built from the configured APP_URL (https://pilot.clubops.ru in
  // production). null when APP_URL is misconfigured — the client then falls back
  // to the current origin so invite creation never breaks.
  inviteUrl?: string;
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

  // Production must mint the invitation link from a configured, valid APP_URL —
  // never from Host / forwarded headers / browser origin. Fail BEFORE creating
  // the invite so no row exists for a link we cannot build correctly. Outside
  // production a localhost base is allowed for developer convenience.
  const appBase = getAppUrlSafe();
  if (process.env.NODE_ENV === "production" && !appBase) {
    return { ok: false, error: "Не настроен адрес приложения. Обратитесь к администратору системы." };
  }

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
  const invitePath = `/accept-invite?token=${token}`;
  // In production appBase is guaranteed non-null by the guard above; in dev it is
  // the localhost base. The client only falls back to its origin outside prod.
  return { ok: true, invitePath, inviteUrl: appBase ? `${appBase}${invitePath}` : undefined };
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
    // Never remove the last active Owner of a company.
    if (row.role === "owner" && (await isLastActiveOwner(row.companyId, row.userId))) {
      throw new Error("Нельзя отключить последнего собственника компании.");
    }
    // Atomic: remove access AND revoke the affected user's sessions. Even a
    // privilege removal forces re-login before the new permission set applies.
    const revoked = await prisma.$transaction(async (tx) => {
      await tx.companyUserAccess.delete({ where: { id: accessId } });
      return revokeAllSessionsForUser(row.userId, "access_changed", user.id, tx);
    });
    await recordAudit({
      action: "access.removed",
      entityType: "CompanyUserAccess",
      entityId: accessId,
      companyId: row.companyId,
      userId: user.id,
      metadata: { targetUserId: row.userId, role: row.role },
    });
    await recordAudit({
      action: "user.access_changed",
      entityType: "User",
      entityId: row.userId,
      companyId: row.companyId,
      userId: user.id,
      metadata: { targetUserId: row.userId, role: row.role, change: "company_access_removed", revokedSessions: revoked },
    });
  } else if (scope === "club") {
    const row = await prisma.clubUserAccess.findUnique({ where: { id: accessId } });
    if (!row) throw new Error("Доступ не найден");
    if (row.userId === user.id) throw new Error("Нельзя удалить собственный доступ");
    if (!(await canManageClubUsers(user.id, row.clubId))) {
      throw new Error("Недостаточно прав");
    }
    const revoked = await prisma.$transaction(async (tx) => {
      await tx.clubUserAccess.delete({ where: { id: accessId } });
      return revokeAllSessionsForUser(row.userId, "access_changed", user.id, tx);
    });
    await recordAudit({
      action: "access.removed",
      entityType: "ClubUserAccess",
      entityId: accessId,
      clubId: row.clubId,
      userId: user.id,
      metadata: { targetUserId: row.userId, role: row.role },
    });
    await recordAudit({
      action: "user.access_changed",
      entityType: "User",
      entityId: row.userId,
      clubId: row.clubId,
      userId: user.id,
      metadata: { targetUserId: row.userId, role: row.role, change: "club_access_removed", revokedSessions: revoked },
    });
  } else {
    throw new Error("Неверный тип доступа");
  }

  revalidatePath("/users");
}

type AdminState = { ok: boolean; error?: string };

/**
 * Administrative: revoke EVERY active session of a managed user. The target's
 * cookie cannot be deleted remotely, but their DB sessions become invalid
 * immediately, so the next request/server action is denied and requires login.
 */
export async function adminRevokeUserSessions(_prev: AdminState | undefined, formData: FormData): Promise<AdminState> {
  const user = await requireUser();
  const targetUserId = String(formData.get("targetUserId") ?? "").trim();
  try {
    const scope = await getCurrentCompanyAndClub(user);
    if (!scope.company) return { ok: false, error: "Нет доступной компании" };
    const companyId = scope.company.id;

    const decision = await assertCanManageUser(user.id, targetUserId, companyId);
    if (!decision.ok) {
      await recordAudit({
        action: "user.session_revocation_blocked",
        entityType: "User", entityId: targetUserId, companyId, userId: user.id,
        metadata: { targetUserId, reason: "not_authorized" },
      });
      return { ok: false, error: decision.error };
    }

    const revoked = await revokeAllSessionsForUser(targetUserId, "admin_revoked", user.id);
    await recordAudit({
      action: "session.revoked_all",
      entityType: "User", entityId: targetUserId, companyId, userId: user.id,
      metadata: { targetUserId, revokedSessions: revoked, by: "admin" },
    });
    revalidatePath("/users");
    return { ok: true };
  } catch (error) {
    console.error("adminRevokeUserSessions failed", error);
    return { ok: false, error: "Не удалось завершить сессии. Обновите страницу и повторите попытку." };
  }
}

/**
 * Administrative: deactivate or reactivate a managed user. Deactivation sets
 * isActive=false AND revokes all sessions atomically (blocks new logins +
 * invalidates open tabs). Reactivation sets isActive=true but never restores old
 * sessions — the user must log in again. User, access rows and history are kept.
 */
export async function adminSetUserActive(_prev: AdminState | undefined, formData: FormData): Promise<AdminState> {
  const user = await requireUser();
  const targetUserId = String(formData.get("targetUserId") ?? "").trim();
  const active = String(formData.get("active") ?? "") === "true";
  try {
    const scope = await getCurrentCompanyAndClub(user);
    if (!scope.company) return { ok: false, error: "Нет доступной компании" };
    const companyId = scope.company.id;

    const decision = await assertCanManageUser(user.id, targetUserId, companyId);
    if (!decision.ok) return { ok: false, error: decision.error };

    // Never deactivate the last active Owner of the company.
    if (!active && (await isLastActiveOwner(companyId, targetUserId))) {
      return { ok: false, error: "Нельзя отключить последнего собственника компании." };
    }

    if (active) {
      await prisma.user.update({ where: { id: targetUserId }, data: { isActive: true } });
      await recordAudit({
        action: "user.reactivated",
        entityType: "User", entityId: targetUserId, companyId, userId: user.id,
        metadata: { targetUserId },
      });
    } else {
      const revoked = await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: targetUserId }, data: { isActive: false } });
        return revokeAllSessionsForUser(targetUserId, "user_deactivated", user.id, tx);
      });
      await recordAudit({
        action: "user.deactivated",
        entityType: "User", entityId: targetUserId, companyId, userId: user.id,
        metadata: { targetUserId, revokedSessions: revoked },
      });
    }
    revalidatePath("/users");
    return { ok: true };
  } catch (error) {
    console.error("adminSetUserActive failed", error);
    return { ok: false, error: "Не удалось изменить статус пользователя. Обновите страницу и повторите попытку." };
  }
}
