"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser, verifyPassword } from "@/lib/auth";
import { recordAudit } from "@/lib/access";
import { revokeCurrentSession } from "@/lib/session";
import { absoluteUrlSafe } from "@/lib/app-url";
import { maskEmail } from "@/lib/otp";
import {
  checkSelfDeletionEligibility,
  finalizeDeletion,
  isDeletionConfirmed,
  DELETION_CONFIRM_WORD,
} from "@/lib/account-deletion";
import { sendRecoveryLinkEmail, sendDeletionCompletedEmail } from "@/lib/email";

type State = { ok: boolean; error?: string };

/**
 * Self-service account deletion — a SINGLE step re-authenticated with the current
 * password + a typed «УДАЛИТЬ» confirmation. No email OTP and no recovery secret
 * are required for the deletion to succeed, so it works in every environment.
 * Only the CURRENT authenticated user can be deleted (no userId/email from the
 * client is ever accepted).
 */
export async function deleteCurrentAccount(_prev: State | undefined, formData: FormData): Promise<State> {
  const current = await requireUser();
  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "");

  if (!isDeletionConfirmed(confirmation)) {
    return { ok: false, error: `Введите «${DELETION_CONFIRM_WORD}» для подтверждения.` };
  }

  // Re-load from the DB (never trust the session snapshot) and re-authenticate.
  const user = await prisma.user.findUnique({
    where: { id: current.id },
    select: { passwordHash: true, email: true, isActive: true, deletedAt: true },
  });
  if (!user || user.deletedAt || !user.isActive) {
    return { ok: false, error: "Аккаунт уже удалён или сессия недействительна." };
  }
  if (!user.passwordHash) {
    // Password-less (OTP-only) accounts cannot re-authenticate here. We do not
    // invent a password; deletion is blocked with a clear, safe message.
    return { ok: false, error: "Для удаления аккаунта требуется подтверждение паролем. Обратитесь к администратору системы." };
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, error: "Неверный пароль." };
  }

  // Sole-owner blocker (re-checked atomically inside finalizeDeletion too).
  const eligible = await checkSelfDeletionEligibility(current.id);
  if (!eligible.ok) return { ok: false, error: eligible.error };

  await recordAudit({
    action: "account.deletion_confirmed", entityType: "User", entityId: current.id, userId: current.id,
    metadata: { maskedEmail: maskEmail(user.email) },
  });

  const result = await finalizeDeletion({ userId: current.id, requestedByUserId: current.id, requestType: "self" });
  if (!result.ok) return { ok: false, error: result.error };

  // If a recovery record was created (secret configured), email the recovery
  // link + a completion notice to the ORIGINAL email — strictly best-effort; a
  // failure here never undoes the completed deletion.
  if (result.recoveryToken) {
    const requestId = current.id.slice(0, 8);
    const restoreUrl = absoluteUrlSafe(`/restore-account?token=${result.recoveryToken}`);
    try {
      if (restoreUrl) await sendRecoveryLinkEmail(result.originalEmail, restoreUrl, requestId);
      await sendDeletionCompletedEmail(result.originalEmail, requestId, false);
    } catch {
      // ignore — deletion already committed; email delivery is non-critical.
    }
  }

  await revokeCurrentSession("account_deleted");
  redirect("/login?deleted=1");
}
