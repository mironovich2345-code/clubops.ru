// Account soft-deletion (tombstoning) service. NEVER physically deletes the User
// (financial createdBy relations are onDelete: Restrict). Releases the email for
// immediate reuse, preserves financial/audit history, and opens a 30-day
// recovery window. Server-only.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/access";
import { maskEmail } from "@/lib/otp";
import { normalizeEmail } from "@/lib/normalize-email";
import { encryptEmail, emailLookupHash, generateRecoveryToken } from "@/lib/account-recovery";
import { isSystemAdminRole } from "@/lib/system-role";

export const RECOVERY_WINDOW_DAYS = 30;
export const SOLE_OWNER_ERROR = "Нельзя удалить единственного собственника компании. Сначала назначьте другого собственника.";

export function tombstoneEmail(userId: string): string {
  return `deleted-${userId}@account.invalid`;
}

type Db = typeof prisma | Prisma.TransactionClient;

/**
 * The first Company where `userId` is the ONLY active owner (blocks deletion),
 * or null. A Company may have several owners; deletion is allowed only when
 * every Company the user owns keeps at least one OTHER active, non-deleted owner.
 */
export async function soleOwnerBlockingCompany(userId: string, db: Db = prisma): Promise<string | null> {
  const ownerRows = await db.companyUserAccess.findMany({ where: { userId, role: "owner" }, select: { companyId: true } });
  for (const { companyId } of ownerRows) {
    const others = await db.companyUserAccess.findMany({
      where: { companyId, role: "owner", userId: { not: userId }, user: { isActive: true, deletedAt: null } },
      select: { userId: true },
    });
    if (new Set(others.map((o) => o.userId)).size === 0) return companyId;
  }
  return null;
}

export type Eligibility = { ok: true } | { ok: false; error: string; code: "sole_owner" | "scope" | "not_found" | "already_deleted" | "system_admin" };

/** Self-deletion eligibility (checked before OTP and again in the transaction). */
export async function checkSelfDeletionEligibility(userId: string): Promise<Eligibility> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, deletedAt: true } });
  if (!user) return { ok: false, error: "Пользователь не найден.", code: "not_found" };
  if (user.deletedAt || !user.isActive) return { ok: false, error: "Аккаунт уже удалён или неактивен.", code: "already_deleted" };
  if (await soleOwnerBlockingCompany(userId)) return { ok: false, error: SOLE_OWNER_ERROR, code: "sole_owner" };
  return { ok: true };
}

/** Owner-initiated deletion eligibility (Part 7 + sole-owner + scope). */
export async function checkOwnerDeletionEligibility(actorId: string, targetId: string): Promise<Eligibility> {
  if (actorId === targetId) return { ok: false, error: "Используйте самостоятельное удаление аккаунта.", code: "scope" };
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { isActive: true, deletedAt: true, systemRole: true } });
  if (!target) return { ok: false, error: "Пользователь не найден.", code: "not_found" };
  if (target.deletedAt) return { ok: false, error: "Аккаунт уже удалён.", code: "already_deleted" };
  if (isSystemAdminRole(target.systemRole)) return { ok: false, error: "Нельзя удалить системного администратора.", code: "system_admin" };

  // Requester must be an active owner of a Company, and must own EVERY Company
  // where the target holds active access (company-level or via a club).
  const requesterOwned = new Set(
    (await prisma.companyUserAccess.findMany({ where: { userId: actorId, role: "owner" }, select: { companyId: true } })).map((r) => r.companyId),
  );
  if (requesterOwned.size === 0) return { ok: false, error: "Только собственник может удалить пользователя.", code: "scope" };

  const targetCompanyIds = new Set<string>();
  (await prisma.companyUserAccess.findMany({ where: { userId: targetId }, select: { companyId: true } })).forEach((r) => targetCompanyIds.add(r.companyId));
  (await prisma.clubUserAccess.findMany({ where: { userId: targetId }, select: { club: { select: { companyId: true } } } })).forEach((r) => targetCompanyIds.add(r.club.companyId));

  if (targetCompanyIds.size === 0) return { ok: false, error: "Пользователь не входит в вашу организацию.", code: "scope" };
  for (const cid of targetCompanyIds) {
    if (!requesterOwned.has(cid)) return { ok: false, error: "У пользователя есть доступ вне ваших организаций.", code: "scope" };
  }
  if (await soleOwnerBlockingCompany(targetId)) return { ok: false, error: SOLE_OWNER_ERROR, code: "sole_owner" };
  return { ok: true };
}

export type FinalizeResult =
  | { ok: true; recoveryToken: string; originalEmail: string; restoreUntil: Date; deletionId: string }
  | { ok: false; error: string; code: string };

/**
 * Atomically tombstone the user (Part 9). Idempotent: a conditional update on
 * (id, deletedAt: null) guarantees a repeated/concurrent confirmation deletes
 * once and never creates a second tombstone or recovery record.
 */
export async function finalizeDeletion(opts: {
  userId: string; requestedByUserId: string | null; requestType: "self" | "owner" | "system_admin";
}): Promise<FinalizeResult> {
  const { userId, requestedByUserId, requestType } = opts;
  const now = new Date();
  const restoreUntil = new Date(now.getTime() + RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const { token, tokenHash } = generateRecoveryToken();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, deletedAt: true, isActive: true } });
      if (!user) return { kind: "not_found" as const };
      if (user.deletedAt) return { kind: "already" as const };

      // Re-check sole-owner INSIDE the transaction (concurrent owner changes).
      if (await soleOwnerBlockingCompany(userId, tx)) return { kind: "sole_owner" as const };

      const originalEmail = user.email;
      const normalized = normalizeEmail(originalEmail);

      // Idempotent tombstone: only the first winner flips deletedAt.
      const flipped = await tx.user.updateMany({
        where: { id: userId, deletedAt: null },
        data: {
          email: tombstoneEmail(userId),
          passwordHash: null,
          phone: null,
          emailVerifiedAt: null,
          lastLoginAt: null,
          isActive: false,
          deletedAt: now,
          restoreUntil,
          deletionRequestedAt: now,
        },
      });
      if (flipped.count === 0) return { kind: "already" as const };

      // Remove access; revoke sessions + ALL challenges; expire pending invites.
      await tx.companyUserAccess.deleteMany({ where: { userId } });
      await tx.clubUserAccess.deleteMany({ where: { userId } });
      await tx.userClubAccess.deleteMany({ where: { userId } });
      const sessions = await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason: "account_deleted" } });
      await tx.emailOtpChallenge.updateMany({ where: { userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now, revokedReason: "account_deleted" } });
      const invites = await tx.invite.deleteMany({ where: { email: normalized, acceptedAt: null } });

      const deletion = await tx.accountDeletion.create({
        data: {
          userId,
          requestedByUserId,
          requestType,
          originalEmailEncrypted: encryptEmail(normalized),
          originalEmailHash: emailLookupHash(normalized),
          originalEmailMasked: maskEmail(originalEmail),
          restoreTokenHash: tokenHash,
          restoreUntil,
          confirmedAt: now,
          deletedAt: now,
        },
      });

      return { kind: "ok" as const, originalEmail, deletionId: deletion.id, revokedSessions: sessions.count, revokedInvites: invites.count };
    });

    if (result.kind === "not_found") return { ok: false, error: "Пользователь не найден.", code: "not_found" };
    if (result.kind === "already") return { ok: false, error: "Аккаунт уже удалён.", code: "already_deleted" };
    if (result.kind === "sole_owner") {
      await recordAudit({ action: "account.deletion_blocked_sole_owner", entityType: "User", entityId: userId, userId: requestedByUserId ?? userId, metadata: { requestType } });
      return { ok: false, error: SOLE_OWNER_ERROR, code: "sole_owner" };
    }

    await recordAudit({
      action: "account.deleted", entityType: "User", entityId: userId, userId: requestedByUserId ?? userId,
      metadata: { requestType, maskedEmail: maskEmail(result.originalEmail), revokedSessions: result.revokedSessions, revokedInvites: result.revokedInvites, deletionId: result.deletionId },
    });
    return { ok: true, recoveryToken: token, originalEmail: result.originalEmail, restoreUntil, deletionId: result.deletionId };
  } catch (e) {
    console.error("finalizeDeletion failed", e instanceof Error ? e.message : e);
    return { ok: false, error: "Не удалось удалить аккаунт. Обновите страницу и повторите попытку.", code: "error" };
  }
}
