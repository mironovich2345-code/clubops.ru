// Account restoration within the 30-day window. Restores IDENTITY only — never
// Company/Club access, owner/manager roles, sessions or invitations (those must
// be re-granted by an authorized admin). Server-only.
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/access";
import { hashPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { maskEmail } from "@/lib/otp";
import { normalizeEmail } from "@/lib/normalize-email";
import { decryptEmail, hashRecoveryToken } from "@/lib/account-recovery";

export const EMAIL_REUSE_MESSAGE =
  "Этот email уже используется новым аккаунтом. Для восстановления обратитесь к системному администратору CLUB-OPS.";

export type RestorableLookup =
  | { ok: true; deletionId: string; userId: string; originalEmail: string; maskedEmail: string }
  | { ok: false; code: "invalid" | "expired" | "reused" };

/**
 * Resolve a recovery token to a restorable account. Fails closed and generic:
 * unknown/expired/used tokens all map to "invalid" (no enumeration). "reused"
 * only when the token is otherwise valid but the original email is now taken.
 */
export async function lookupByRecoveryToken(token: string): Promise<RestorableLookup> {
  if (!token) return { ok: false, code: "invalid" };
  const deletion = await prisma.accountDeletion.findUnique({
    where: { restoreTokenHash: hashRecoveryToken(token) },
    select: { id: true, userId: true, restoreUntil: true, restoredAt: true, recoveryPurgedAt: true, originalEmailEncrypted: true, originalEmailMasked: true },
  });
  if (!deletion || deletion.restoredAt || deletion.recoveryPurgedAt) return { ok: false, code: "invalid" };
  if (deletion.restoreUntil.getTime() < Date.now()) return { ok: false, code: "expired" };
  const user = await prisma.user.findUnique({ where: { id: deletion.userId }, select: { deletedAt: true } });
  if (!user || !user.deletedAt) return { ok: false, code: "invalid" }; // account no longer deleted

  const originalEmail = decryptEmail(deletion.originalEmailEncrypted);
  if (!originalEmail) return { ok: false, code: "invalid" };

  // Email-reuse conflict: a NEW independent account already holds the address.
  const taken = await prisma.user.findUnique({ where: { email: normalizeEmail(originalEmail) }, select: { id: true } });
  if (taken && taken.id !== deletion.userId) return { ok: false, code: "reused" };

  return { ok: true, deletionId: deletion.id, userId: deletion.userId, originalEmail, maskedEmail: deletion.originalEmailMasked };
}

export type RestoreResult = { ok: true } | { ok: false; error: string; code: "invalid" | "expired" | "reused" | "weak_password" | "error" };

/**
 * Finalize restoration after the recovery OTP has been verified by the caller.
 * Atomic + idempotent (conditional update on the still-deleted user). Restores
 * the original email ONLY if still free. Creates NO session.
 */
export async function finalizeRestore(opts: { token: string; newPassword: string }): Promise<RestoreResult> {
  const { token, newPassword } = opts;
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`, code: "weak_password" };
  }
  const lookup = await lookupByRecoveryToken(token);
  if (!lookup.ok) {
    if (lookup.code === "reused") return { ok: false, error: EMAIL_REUSE_MESSAGE, code: "reused" };
    if (lookup.code === "expired") return { ok: false, error: "Срок восстановления истёк.", code: "expired" };
    return { ok: false, error: "Ссылка восстановления недействительна.", code: "invalid" };
  }
  const passwordHash = await hashPassword(newPassword);
  const normalized = normalizeEmail(lookup.originalEmail);
  const now = new Date();

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Re-check the email is still free inside the transaction.
      const taken = await tx.user.findUnique({ where: { email: normalized }, select: { id: true } });
      if (taken && taken.id !== lookup.userId) return "reused" as const;

      const restored = await tx.user.updateMany({
        where: { id: lookup.userId, deletedAt: { not: null } },
        data: { email: normalized, passwordHash, isActive: true, emailVerifiedAt: now, deletedAt: null, restoreUntil: null, deletionRequestedAt: null },
      });
      if (restored.count === 0) return "invalid" as const;

      await tx.accountDeletion.update({ where: { id: lookup.deletionId }, data: { restoredAt: now, restoreTokenHash: null } });
      // Invalidate any outstanding deletion/restore challenges for this user.
      await tx.emailOtpChallenge.updateMany({ where: { userId: lookup.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now, revokedReason: "account_restored" } });
      return "ok" as const;
    });

    if (outcome === "reused") return { ok: false, error: EMAIL_REUSE_MESSAGE, code: "reused" };
    if (outcome === "invalid") return { ok: false, error: "Ссылка восстановления недействительна.", code: "invalid" };

    await recordAudit({ action: "account.restored", entityType: "User", entityId: lookup.userId, userId: lookup.userId, metadata: { maskedEmail: maskEmail(lookup.originalEmail), via: "recovery_token" } });
    return { ok: true };
  } catch (e) {
    console.error("finalizeRestore failed", e instanceof Error ? e.message : e);
    return { ok: false, error: "Не удалось восстановить аккаунт. Повторите попытку.", code: "error" };
  }
}

/**
 * System-admin alternate-email restore (Part 12): restore the old identity under
 * a DIFFERENT, newly-verified email. Caller must be a system_admin and must have
 * verified an OTP to `newEmail`. Atomic; audited.
 */
export async function systemAdminAlternateRestore(opts: {
  deletionId: string; newEmail: string; newPassword: string; actorUserId: string;
}): Promise<RestoreResult> {
  const { deletionId, newEmail, newPassword, actorUserId } = opts;
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`, code: "weak_password" };
  }
  const normalized = normalizeEmail(newEmail);
  const passwordHash = await hashPassword(newPassword);
  const now = new Date();
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const deletion = await tx.accountDeletion.findUnique({ where: { id: deletionId }, select: { userId: true, restoredAt: true } });
      if (!deletion || deletion.restoredAt) return "invalid" as const;
      const taken = await tx.user.findUnique({ where: { email: normalized }, select: { id: true } });
      if (taken && taken.id !== deletion.userId) return "reused" as const;
      const restored = await tx.user.updateMany({
        where: { id: deletion.userId, deletedAt: { not: null } },
        data: { email: normalized, passwordHash, isActive: true, emailVerifiedAt: now, deletedAt: null, restoreUntil: null, deletionRequestedAt: null },
      });
      if (restored.count === 0) return "invalid" as const;
      await tx.accountDeletion.update({ where: { id: deletionId }, data: { restoredAt: now, restoreTokenHash: null } });
      await tx.emailOtpChallenge.updateMany({ where: { userId: deletion.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now, revokedReason: "account_restored" } });
      return { userId: deletion.userId } as { userId: string };
    });
    if (outcome === "invalid") return { ok: false, error: "Запись восстановления недействительна.", code: "invalid" };
    if (outcome === "reused") return { ok: false, error: EMAIL_REUSE_MESSAGE, code: "reused" };
    await recordAudit({ action: "system_admin.alternate_email_restore", entityType: "User", entityId: outcome.userId, userId: actorUserId, metadata: { maskedEmail: maskEmail(newEmail), deletionId } });
    return { ok: true };
  } catch (e) {
    console.error("systemAdminAlternateRestore failed", e instanceof Error ? e.message : e);
    return { ok: false, error: "Не удалось восстановить аккаунт.", code: "error" };
  }
}
