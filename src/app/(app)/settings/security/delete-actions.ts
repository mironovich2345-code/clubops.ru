"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser, verifyPassword } from "@/lib/auth";
import { recordAudit } from "@/lib/access";
import { revokeCurrentSession } from "@/lib/session";
import { absoluteUrlSafe } from "@/lib/app-url";
import { maskEmail } from "@/lib/otp";
import { recoveryConfigured } from "@/lib/account-recovery";
import { startActionChallenge, verifyActionChallenge, clearActionCookie } from "@/lib/action-challenge";
import { checkSelfDeletionEligibility, finalizeDeletion } from "@/lib/account-deletion";
import { sendRecoveryLinkEmail, sendDeletionCompletedEmail } from "@/lib/email";

type State = { ok: boolean; stage?: "password" | "otp" | "done"; error?: string };

const CONFIG_ERROR = "Удаление аккаунта временно недоступно. Обратитесь к администратору системы.";

/**
 * Step 1: confirm current password + eligibility, then send a SEPARATE deletion
 * OTP (never reuses a login OTP). Generic errors; no enumeration.
 */
export async function startSelfDeletion(_prev: State | undefined, formData: FormData): Promise<State> {
  const current = await requireUser();
  const password = String(formData.get("password") ?? "");
  if (!recoveryConfigured()) return { ok: false, stage: "password", error: CONFIG_ERROR };

  const user = await prisma.user.findUnique({ where: { id: current.id }, select: { passwordHash: true, email: true, isActive: true } });
  if (!user || !user.passwordHash || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, stage: "password", error: "Неверный пароль." };
  }
  const eligible = await checkSelfDeletionEligibility(current.id);
  if (!eligible.ok) return { ok: false, stage: "password", error: eligible.error };

  await recordAudit({ action: "account.deletion_started", entityType: "User", entityId: current.id, userId: current.id, metadata: { maskedEmail: maskEmail(user.email) } });
  const sent = await startActionChallenge({ userId: current.id, deliverTo: user.email, purpose: "account_deletion", kind: "deletion" });
  if (!sent.ok) {
    return { ok: false, stage: "otp", error: sent.error === "rate" ? "Слишком много попыток. Повторите позже." : "Не удалось отправить код. Повторите попытку позже." };
  }
  return { ok: true, stage: "otp" };
}

/** Resend the deletion OTP (server-enforced supersede + limits). Form action. */
export async function resendSelfDeletionOtp(): Promise<void> {
  const current = await requireUser();
  const user = await prisma.user.findUnique({ where: { id: current.id }, select: { email: true } });
  if (!user) return;
  await startActionChallenge({ userId: current.id, deliverTo: user.email, purpose: "account_deletion", kind: "deletion" });
}

/**
 * Step 2: verify the deletion OTP, re-check eligibility, then finalize deletion
 * atomically, email the recovery link + notice, revoke the current session and
 * redirect to login. A verified challenge is consumed once (replay-safe).
 */
export async function confirmSelfDeletion(_prev: State | undefined, formData: FormData): Promise<State> {
  const current = await requireUser();
  const code = String(formData.get("code") ?? "").trim();

  const verify = await verifyActionChallenge("account_deletion", code);
  if (!verify.ok) {
    if (verify.locked) return { ok: false, stage: "password", error: "Слишком много неверных кодов. Начните заново." };
    if (verify.expired) return { ok: false, stage: "password", error: "Сеанс подтверждения истёк. Начните заново." };
    return { ok: false, stage: "otp", error: "Неверный или просроченный код." };
  }
  if (verify.user && verify.user.id !== current.id) {
    return { ok: false, stage: "password", error: "Сеанс подтверждения недействителен." };
  }

  const eligible = await checkSelfDeletionEligibility(current.id);
  if (!eligible.ok) return { ok: false, stage: "password", error: eligible.error };

  await recordAudit({ action: "account.deletion_confirmed", entityType: "User", entityId: current.id, userId: current.id });
  const result = await finalizeDeletion({ userId: current.id, requestedByUserId: current.id, requestType: "self" });
  if (!result.ok) {
    await clearActionCookie("account_deletion");
    return { ok: false, stage: "password", error: result.error };
  }

  // Recovery link + completion notice to the ORIGINAL email (best-effort).
  const requestId = current.id.slice(0, 8);
  const restoreUrl = absoluteUrlSafe(`/restore-account?token=${result.recoveryToken}`);
  if (restoreUrl) await sendRecoveryLinkEmail(result.originalEmail, restoreUrl, requestId);
  await sendDeletionCompletedEmail(result.originalEmail, requestId, false);

  await clearActionCookie("account_deletion");
  await revokeCurrentSession("account_deleted");
  redirect("/login?deleted=1");
}
