"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/access";
import { getCurrentSystemAdmin } from "@/lib/system-role";
import { absoluteUrlSafe } from "@/lib/app-url";
import { maskEmail } from "@/lib/otp";
import { normalizeEmail, isValidEmail } from "@/lib/normalize-email";
import { decryptEmail, generateRecoveryToken } from "@/lib/account-recovery";
import { sendRecoveryLinkEmail } from "@/lib/email";
import { startActionChallenge, verifyActionChallenge, clearActionCookie } from "@/lib/action-challenge";
import { systemAdminAlternateRestore } from "@/lib/account-restore";

type State = { ok: boolean; error?: string; stage?: "start" | "otp"; deletionId?: string; newEmail?: string };

/** Resend the recovery link (fresh single-use token) to the original email. */
export async function resendRecovery(formData: FormData): Promise<void> {
  const admin = await getCurrentSystemAdmin();
  if (!admin) return;
  const deletionId = String(formData.get("deletionId") ?? "").trim();
  const del = await prisma.accountDeletion.findUnique({ where: { id: deletionId } });
  if (!del || del.restoredAt || del.recoveryPurgedAt || del.restoreUntil.getTime() < Date.now()) return;
  const original = decryptEmail(del.originalEmailEncrypted);
  if (!original) return;
  // Do not resend if the original email is now taken by a new account.
  const taken = await prisma.user.findUnique({ where: { email: normalizeEmail(original) }, select: { id: true } });
  if (taken && taken.id !== del.userId) return;

  const { token, tokenHash } = generateRecoveryToken();
  await prisma.accountDeletion.update({ where: { id: del.id }, data: { restoreTokenHash: tokenHash } });
  const url = absoluteUrlSafe(`/restore-account?token=${token}`);
  if (url) await sendRecoveryLinkEmail(original, url, del.id.slice(0, 8));
  await recordAudit({ action: "account.recovery_email_resent", entityType: "User", entityId: del.userId, userId: admin.id, metadata: { maskedEmail: maskEmail(original), deletionId: del.id } });
  revalidatePath("/system-admin/accounts");
}

/** Alternate-email restore step 1: system-admin sends an OTP to the replacement email. */
export async function startAlternateRestore(_prev: State | undefined, formData: FormData): Promise<State> {
  const admin = await getCurrentSystemAdmin();
  if (!admin) return { ok: false, error: "Нет доступа." };
  const deletionId = String(formData.get("deletionId") ?? "").trim();
  const newEmail = normalizeEmail(String(formData.get("newEmail") ?? ""));
  if (!isValidEmail(newEmail)) return { ok: false, stage: "start", error: "Введите корректный email.", deletionId };

  const del = await prisma.accountDeletion.findUnique({ where: { id: deletionId }, select: { userId: true, restoredAt: true } });
  if (!del || del.restoredAt) return { ok: false, stage: "start", error: "Запись восстановления недействительна.", deletionId };
  const taken = await prisma.user.findUnique({ where: { email: newEmail }, select: { id: true } });
  if (taken && taken.id !== del.userId) return { ok: false, stage: "start", error: "Этот email уже используется.", deletionId };

  const sent = await startActionChallenge({ userId: del.userId, deliverTo: newEmail, purpose: "account_restore_admin", kind: "restore" });
  if (!sent.ok) return { ok: false, stage: "start", error: "Не удалось отправить код.", deletionId };
  return { ok: true, stage: "otp", deletionId, newEmail };
}

/** Alternate-email restore step 2: verify OTP + set password → restore under new email. */
export async function confirmAlternateRestore(_prev: State | undefined, formData: FormData): Promise<State> {
  const admin = await getCurrentSystemAdmin();
  if (!admin) return { ok: false, error: "Нет доступа." };
  const deletionId = String(formData.get("deletionId") ?? "").trim();
  const newEmail = normalizeEmail(String(formData.get("newEmail") ?? ""));
  const code = String(formData.get("code") ?? "").trim();
  const newPassword = String(formData.get("password") ?? "");

  const verify = await verifyActionChallenge("account_restore_admin", code);
  if (!verify.ok) {
    if (verify.locked || verify.expired) return { ok: false, stage: "start", error: "Сеанс подтверждения истёк.", deletionId };
    return { ok: false, stage: "otp", error: "Неверный или просроченный код.", deletionId, newEmail };
  }
  const result = await systemAdminAlternateRestore({ deletionId, newEmail, newPassword, actorUserId: admin.id });
  await clearActionCookie("account_restore_admin");
  if (!result.ok) return { ok: false, stage: result.code === "weak_password" ? "otp" : "start", error: result.error, deletionId, newEmail };
  revalidatePath("/system-admin/accounts");
  return { ok: true };
}
