"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser, verifyPassword } from "@/lib/auth";
import {
  getCurrentCompanyAndClub,
  getInvitableRoles,
  canManageClubUsers,
  canManageCompanyUsers,
  userHasCompanyRole,
  assertCanManageUser,
  isLastActiveOwner,
  recordAudit,
} from "@/lib/access";
import { revokeAllSessionsForUser } from "@/lib/session";
import { getAppUrlSafe, absoluteUrlSafe } from "@/lib/app-url";
import { normalizeEmail, isValidEmail } from "@/lib/normalize-email";
import { recoveryConfigured } from "@/lib/account-recovery";
import { startActionChallenge, verifyActionChallenge, clearActionCookie } from "@/lib/action-challenge";
import { checkOwnerDeletionEligibility, finalizeDeletion } from "@/lib/account-deletion";
import {
  sendRecoveryLinkEmail,
  sendDeletionCompletedEmail,
  sendInviteEmail,
  sendAccessGrantedEmail,
} from "@/lib/email";
import {
  generateInviteToken,
  inviteExpiry,
  isClubScopedRole,
  evaluateSendGate,
  INVITE_ROLE_LABELS,
} from "@/lib/invites";
import { grantDirectAccess } from "@/lib/invite-service";

// A short, non-sensitive request id for correlating email-delivery logs. Never
// contains PII or tokens.
function requestId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function inviteScopeLabel(companyName: string, clubName: string | null): string {
  return clubName ? `клуб «${clubName}»` : `компания «${companyName}»`;
}

// Not exported: a "use server" module may only export async functions. The
// client form infers this shape from createInvite's signature.
type InviteState = {
  ok: boolean;
  error?: string;
  // Outcome for the UI: a direct grant to an existing verified user, or a
  // pending invite whose email was (or was not) delivered.
  outcome?: "granted" | "pending";
  notice?: string;
  // Non-fatal email-delivery warning (invite/access was still saved).
  emailWarning?: boolean;
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
  const companyName = scope.company.name;

  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const role = String(formData.get("role") ?? "").trim();
  const clubIdRaw = String(formData.get("clubId") ?? "").trim();

  if (!isValidEmail(email)) return { ok: false, error: "Введите корректный email" };

  // getInvitableRoles is the single source of truth for who may invite which
  // role (owner -> owner/general_director-if-none; GD -> regional/accountant/
  // manager/marketer; regional -> manager). No global User.role is trusted.
  const invitable = await getInvitableRoles(user.id, companyId);
  if (!invitable.includes(role)) {
    return { ok: false, error: "Недостаточно прав для приглашения этой роли" };
  }

  let clubId: string | null = null;
  let clubName: string | null = null;
  if (isClubScopedRole(role)) {
    if (!clubIdRaw) return { ok: false, error: "Для управляющего нужно выбрать клуб" };
    const club = await prisma.club.findFirst({
      where: { id: clubIdRaw, companyId },
      select: { id: true, name: true },
    });
    if (!club) return { ok: false, error: "Клуб не найден в этой компании" };
    if (!(await canManageClubUsers(user.id, clubIdRaw))) {
      return { ok: false, error: "Нет прав управлять этим клубом" };
    }
    clubId = club.id;
    clubName = club.name;
  }
  // Company-level roles (owner/general_director/regional_director/accountant/
  // marketer) are already authorized by getInvitableRoles above.

  const roleLabel = INVITE_ROLE_LABELS[role] ?? role;
  const scopeLabel = inviteScopeLabel(companyName, clubName);

  // Reject if the invited person already has the same access.
  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true, emailVerifiedAt: true, isActive: true, deletedAt: true },
  });
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

  // Scenario 1 — existing, verified, active, non-deleted user: grant directly.
  // No Invite row is created. The grant is idempotent and takes effect on the
  // user's next request (effective roles are recomputed per request).
  if (existingUser && existingUser.emailVerifiedAt && existingUser.isActive && !existingUser.deletedAt) {
    await grantDirectAccess({
      targetUserId: existingUser.id,
      actorUserId: user.id,
      companyId,
      clubId,
      role,
    });
    // Notify the user; an SMTP failure must NOT roll back the granted access.
    const loginUrl = absoluteUrlSafe("/login");
    const res = await sendAccessGrantedEmail(email, { companyName, roleLabel, scopeLabel, loginUrl }, requestId("acc"));
    revalidatePath("/users");
    return {
      ok: true,
      outcome: "granted",
      notice: "Доступ предоставлен.",
      emailWarning: !res.ok,
    };
  }

  // Scenario 2 — user absent or email not yet verified: create a pending invite.
  // Reject a duplicate active (pending, non-expired, non-revoked) invite.
  const pending = await prisma.invite.findFirst({
    where: {
      email,
      companyId,
      clubId,
      role,
      acceptedAt: null,
      revokedAt: null,
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

  const now = new Date();
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
      lastSentAt: now,
      sentCount: 1,
      sendWindowStartedAt: now,
      sendCountInWindow: 1,
    },
  });

  await recordAudit({
    action: "invitation.created",
    entityType: "Invite",
    entityId: invite.id,
    companyId,
    clubId,
    userId: user.id,
    metadata: { email, role },
  });

  // Send the invitation email. Delivery failure never rolls back the invite —
  // it is recorded as a status the admin can retry from the invites list.
  const acceptUrl = appBase ? `${appBase}/accept-invite?token=${token}` : `/accept-invite?token=${token}`;
  const sent = await sendInviteEmail(
    email,
    {
      inviterLabel: user.name,
      roleLabel,
      scopeLabel,
      expiresLabel: invite.expiresAt.toLocaleDateString("ru-RU"),
      acceptUrl,
    },
    requestId("inv"),
  );
  await prisma.invite.update({
    where: { id: invite.id },
    data: { emailDeliveryStatus: sent.ok ? "sent" : "failed" },
  });
  await recordAudit({
    action: sent.ok ? "invitation.email_sent" : "invitation.email_failed",
    entityType: "Invite",
    entityId: invite.id,
    companyId,
    clubId,
    userId: user.id,
    metadata: { role },
  });

  revalidatePath("/users");
  return {
    ok: true,
    outcome: "pending",
    notice: sent.ok
      ? "Приглашение создано и отправлено на email."
      : "Приглашение создано, но письмо отправить не удалось. Повторите отправку из списка приглашений.",
    emailWarning: !sent.ok,
  };
  } catch (error) {
    // Surface a friendly message but keep the real error in the server logs.
    console.error("createInvite failed", error);
    return { ok: false, error: "Не удалось создать приглашение. Попробуйте ещё раз." };
  }
}

// --- Invite management: authorization + token rotation ---------------------

type InviteRow = {
  id: string;
  email: string;
  companyId: string;
  clubId: string | null;
  role: string;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  lastSentAt: Date | null;
  sendWindowStartedAt: Date | null;
  sendCountInWindow: number;
  company: { name: string };
  club: { name: string } | null;
  invitedBy: { name: string };
};

/** May the actor manage (resend/regenerate/revoke) this invite? Cross-company
 * and cross-club invites are denied by the underlying role checks. */
async function canManageInvite(userId: string, invite: { companyId: string; clubId: string | null }): Promise<boolean> {
  if (invite.clubId) return canManageClubUsers(userId, invite.clubId);
  return canManageCompanyUsers(userId, invite.companyId);
}

async function loadManageableInvite(
  userId: string,
  inviteId: string,
): Promise<{ ok: true; invite: InviteRow } | { ok: false; error: string }> {
  const invite = await prisma.invite.findUnique({
    where: { id: inviteId },
    include: { company: { select: { name: true } }, club: { select: { name: true } }, invitedBy: { select: { name: true } } },
  });
  if (!invite) return { ok: false, error: "Приглашение не найдено" };
  if (!(await canManageInvite(userId, invite))) {
    return { ok: false, error: "Недостаточно прав для управления этим приглашением" };
  }
  return { ok: true, invite: invite as unknown as InviteRow };
}

/**
 * Rotate the invite's token under the send rate-limit, race-safe. Issues a NEW
 * raw token (returned once, never stored), invalidates the old tokenHash, always
 * refreshes expiresAt to +7 days (so an expired invite can be re-issued), and
 * updates the send counters. The compare-and-set pins the previously-read
 * (lastSentAt, sendCountInWindow) so two concurrent rotations cannot both pass.
 */
async function rotateInviteToken(
  invite: InviteRow,
): Promise<{ ok: true; token: string } | { ok: false; reason: "cooldown" | "rate" | "conflict" | "not_pending" }> {
  if (invite.acceptedAt) return { ok: false, reason: "not_pending" };
  if (invite.revokedAt) return { ok: false, reason: "not_pending" };

  const now = new Date();
  const gate = evaluateSendGate({
    lastSentAt: invite.lastSentAt,
    sendWindowStartedAt: invite.sendWindowStartedAt,
    sendCountInWindow: invite.sendCountInWindow,
    now,
  });
  if (!gate.ok) return { ok: false, reason: gate.reason };

  const { token, tokenHash } = generateInviteToken();
  const cas = await prisma.invite.updateMany({
    where: {
      id: invite.id,
      acceptedAt: null,
      revokedAt: null,
      // Optimistic lock on the counters we based the gate on.
      lastSentAt: invite.lastSentAt,
      sendCountInWindow: invite.sendCountInWindow,
    },
    data: {
      tokenHash,
      expiresAt: inviteExpiry(),
      lastSentAt: now,
      sentCount: { increment: 1 },
      sendWindowStartedAt: gate.windowStartedAt,
      sendCountInWindow: gate.countInWindow,
    },
  });
  if (cas.count !== 1) return { ok: false, reason: "conflict" };
  return { ok: true, token };
}

function rateLimitMessage(reason: "cooldown" | "rate" | "conflict" | "not_pending"): string {
  switch (reason) {
    case "cooldown":
      return "Подождите минуту перед повторной отправкой.";
    case "rate":
      return "Достигнут лимит отправок (5 за сутки). Повторите позже.";
    case "conflict":
      return "Приглашение только что изменилось. Обновите страницу.";
    case "not_pending":
      return "Действие недоступно для этого приглашения.";
  }
}

type InviteActionState = { ok: boolean; error?: string; notice?: string; linkUrl?: string; emailWarning?: boolean };

/**
 * Resend: issue a NEW token (old link stops working) and email the new link.
 * Subject to the 60s cooldown + 5/24h limit. An accepted or revoked invite
 * cannot be resent; an expired one can (it is re-issued for another 7 days).
 */
export async function resendInvite(_prev: InviteActionState | undefined, formData: FormData): Promise<InviteActionState> {
  const user = await requireUser();
  const inviteId = String(formData.get("inviteId") ?? "").trim();
  try {
    const loaded = await loadManageableInvite(user.id, inviteId);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const invite = loaded.invite;

    const appBase = getAppUrlSafe();
    if (process.env.NODE_ENV === "production" && !appBase) {
      return { ok: false, error: "Не настроен адрес приложения. Обратитесь к администратору системы." };
    }

    const rotated = await rotateInviteToken(invite);
    if (!rotated.ok) return { ok: false, error: rateLimitMessage(rotated.reason) };

    const acceptUrl = appBase
      ? `${appBase}/accept-invite?token=${rotated.token}`
      : `/accept-invite?token=${rotated.token}`;
    const sent = await sendInviteEmail(
      invite.email,
      {
        inviterLabel: invite.invitedBy.name,
        roleLabel: INVITE_ROLE_LABELS[invite.role] ?? invite.role,
        scopeLabel: inviteScopeLabel(invite.company.name, invite.club?.name ?? null),
        expiresLabel: inviteExpiry().toLocaleDateString("ru-RU"),
        acceptUrl,
      },
      requestId("inv"),
    );
    await prisma.invite.update({
      where: { id: invite.id },
      data: { emailDeliveryStatus: sent.ok ? "sent" : "failed" },
    });
    await recordAudit({
      action: "invitation.resent",
      entityType: "Invite",
      entityId: invite.id,
      companyId: invite.companyId,
      clubId: invite.clubId,
      userId: user.id,
      metadata: { role: invite.role, delivered: sent.ok },
    });
    await recordAudit({
      action: sent.ok ? "invitation.email_sent" : "invitation.email_failed",
      entityType: "Invite",
      entityId: invite.id,
      companyId: invite.companyId,
      clubId: invite.clubId,
      userId: user.id,
      metadata: { role: invite.role },
    });
    revalidatePath("/users");
    return {
      ok: true,
      notice: sent.ok ? "Письмо отправлено." : "Не удалось отправить письмо. Повторите позже.",
      emailWarning: !sent.ok,
    };
  } catch (error) {
    console.error("resendInvite failed", error);
    return { ok: false, error: "Не удалось отправить приглашение. Повторите попытку." };
  }
}

/**
 * Regenerate link: issue a NEW token, invalidate the old link, and return the
 * absolute URL ONCE. No email is sent. Same cooldown/limit as resend. The raw
 * URL is never stored or written to the audit log.
 */
export async function regenerateInviteLink(
  _prev: InviteActionState | undefined,
  formData: FormData,
): Promise<InviteActionState> {
  const user = await requireUser();
  const inviteId = String(formData.get("inviteId") ?? "").trim();
  try {
    const loaded = await loadManageableInvite(user.id, inviteId);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const invite = loaded.invite;

    const appBase = getAppUrlSafe();
    if (process.env.NODE_ENV === "production" && !appBase) {
      return { ok: false, error: "Не настроен адрес приложения. Обратитесь к администратору системы." };
    }

    const rotated = await rotateInviteToken(invite);
    if (!rotated.ok) return { ok: false, error: rateLimitMessage(rotated.reason) };

    await recordAudit({
      action: "invitation.link_regenerated",
      entityType: "Invite",
      entityId: invite.id,
      companyId: invite.companyId,
      clubId: invite.clubId,
      userId: user.id,
      metadata: { role: invite.role },
    });
    revalidatePath("/users");
    const linkUrl = appBase
      ? `${appBase}/accept-invite?token=${rotated.token}`
      : `/accept-invite?token=${rotated.token}`;
    return { ok: true, notice: "Сформирована новая ссылка. Предыдущая больше не действует.", linkUrl };
  } catch (error) {
    console.error("regenerateInviteLink failed", error);
    return { ok: false, error: "Не удалось сформировать ссылку. Повторите попытку." };
  }
}

/**
 * Revoke: set revokedAt (never deletes the row, never masks via expiresAt). An
 * already-accepted invite cannot be revoked. After revocation the link stops
 * working and resend is blocked.
 */
export async function revokeInvite(_prev: InviteActionState | undefined, formData: FormData): Promise<InviteActionState> {
  const user = await requireUser();
  const inviteId = String(formData.get("inviteId") ?? "").trim();
  try {
    const loaded = await loadManageableInvite(user.id, inviteId);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const invite = loaded.invite;

    if (invite.acceptedAt) return { ok: false, error: "Принятое приглашение нельзя отозвать." };
    if (invite.revokedAt) return { ok: true, notice: "Приглашение уже отозвано." };

    // Race-safe: only flip a still-pending, still-unaccepted invite.
    const cas = await prisma.invite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (cas.count !== 1) return { ok: false, error: "Приглашение уже изменилось. Обновите страницу." };

    await recordAudit({
      action: "invitation.revoked",
      entityType: "Invite",
      entityId: invite.id,
      companyId: invite.companyId,
      clubId: invite.clubId,
      userId: user.id,
      metadata: { role: invite.role },
    });
    revalidatePath("/users");
    return { ok: true, notice: "Приглашение отозвано." };
  } catch (error) {
    console.error("revokeInvite failed", error);
    return { ok: false, error: "Не удалось отозвать приглашение. Повторите попытку." };
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

// --- Owner-initiated account deletion (Part 7) -----------------------------
type OwnerDeleteState = { ok: boolean; stage?: "start" | "otp"; error?: string; targetUserId?: string };

/**
 * Step 1: an active owner confirms THEIR password + strict eligibility, then a
 * deletion OTP is sent to the OWNER's email (owner reauthentication). Never
 * reuses a login OTP. The target does NOT confirm.
 */
export async function startOwnerDeletion(_prev: OwnerDeleteState | undefined, formData: FormData): Promise<OwnerDeleteState> {
  const actor = await requireUser();
  const targetUserId = String(formData.get("targetUserId") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!recoveryConfigured()) return { ok: false, stage: "start", error: "Удаление недоступно. Обратитесь к администратору системы.", targetUserId };

  const me = await prisma.user.findUnique({ where: { id: actor.id }, select: { passwordHash: true, email: true, isActive: true } });
  if (!me || !me.passwordHash || !me.isActive || !(await verifyPassword(password, me.passwordHash))) {
    return { ok: false, stage: "start", error: "Неверный пароль.", targetUserId };
  }
  const eligible = await checkOwnerDeletionEligibility(actor.id, targetUserId);
  if (!eligible.ok) {
    if (eligible.code === "scope") await recordAudit({ action: "account.deletion_blocked_scope", entityType: "User", entityId: targetUserId, userId: actor.id });
    return { ok: false, stage: "start", error: eligible.error, targetUserId };
  }
  await recordAudit({ action: "account.deletion_started", entityType: "User", entityId: targetUserId, userId: actor.id, metadata: { by: "owner" } });
  const sent = await startActionChallenge({ userId: actor.id, deliverTo: me.email, purpose: "owner_delete", kind: "deletion" });
  if (!sent.ok) return { ok: false, stage: "otp", error: "Не удалось отправить код. Повторите позже.", targetUserId };
  return { ok: true, stage: "otp", targetUserId };
}

/** Step 2: verify the owner's OTP, re-check eligibility, then delete the target. */
export async function confirmOwnerDeletion(_prev: OwnerDeleteState | undefined, formData: FormData): Promise<OwnerDeleteState> {
  const actor = await requireUser();
  const targetUserId = String(formData.get("targetUserId") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();

  const verify = await verifyActionChallenge("owner_delete", code);
  if (!verify.ok) {
    if (verify.locked || verify.expired) return { ok: false, stage: "start", error: "Сеанс подтверждения истёк. Начните заново.", targetUserId };
    return { ok: false, stage: "otp", error: "Неверный или просроченный код.", targetUserId };
  }
  if (verify.user && verify.user.id !== actor.id) return { ok: false, stage: "start", error: "Сеанс недействителен.", targetUserId };

  const eligible = await checkOwnerDeletionEligibility(actor.id, targetUserId);
  if (!eligible.ok) return { ok: false, stage: "start", error: eligible.error, targetUserId };

  const result = await finalizeDeletion({ userId: targetUserId, requestedByUserId: actor.id, requestType: "owner" });
  await clearActionCookie("owner_delete");
  if (!result.ok) return { ok: false, stage: "start", error: result.error, targetUserId };

  // Notify the target on their ORIGINAL email + send the recovery link (only
  // when a recovery record was created — i.e. the recovery secret is configured).
  const requestId = targetUserId.slice(0, 8);
  if (result.recoveryToken) {
    const restoreUrl = absoluteUrlSafe(`/restore-account?token=${result.recoveryToken}`);
    if (restoreUrl) await sendRecoveryLinkEmail(result.originalEmail, restoreUrl, requestId);
  }
  await sendDeletionCompletedEmail(result.originalEmail, requestId, true);
  // finalizeDeletion already writes the account.deleted audit event.

  revalidatePath("/users");
  return { ok: true };
}
