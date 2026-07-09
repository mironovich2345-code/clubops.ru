"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser, verifyPassword, hashPassword } from "@/lib/auth";
import { recordAudit } from "@/lib/access";
import { getCurrentSessionId, revokeOtherSessions } from "@/lib/session";
import { hashToken } from "@/lib/tokens";
import { normalizeEmail } from "@/lib/normalize-email";
import { maskEmail, OTP_TTL_MS } from "@/lib/otp";
import { emailConfigured } from "@/lib/email";
import {
  startActionChallenge, verifyActionChallenge, clearActionCookie, revokeActionChallenges,
} from "@/lib/action-challenge";
import {
  validateNameField, composeDisplayName, validateNewPassword, validateNewEmail,
} from "@/lib/account-settings";

const EMAIL_DISABLED = "Изменение недоступно: почтовый сервис не настроен. Обратитесь к администратору системы.";

// ============================ Personal data (name) ==========================

type ProfileState = { ok: boolean; error?: string };

/** Update the current user's first/last name (derives `name`). No OTP/password —
 * a low-risk change. Optimistic lock on updatedAt; a tombstoned user is refused. */
export async function updateProfile(_prev: ProfileState | undefined, formData: FormData): Promise<ProfileState> {
  const current = await requireUser();
  const firstCheck = validateNameField(String(formData.get("firstName") ?? ""), "Имя");
  if (!firstCheck.ok) return { ok: false, error: firstCheck.error };
  const lastCheck = validateNameField(String(formData.get("lastName") ?? ""), "Фамилия");
  if (!lastCheck.ok) return { ok: false, error: lastCheck.error };

  const user = await prisma.user.findUnique({ where: { id: current.id }, select: { isActive: true, deletedAt: true, updatedAt: true } });
  if (!user || user.deletedAt || !user.isActive) return { ok: false, error: "Аккаунт недоступен." };

  const expected = String(formData.get("updatedAt") ?? "");
  if (expected && expected !== user.updatedAt.toISOString()) {
    return { ok: false, error: "Данные уже изменились. Обновите страницу." };
  }

  const name = composeDisplayName(firstCheck.value, lastCheck.value);
  const res = await prisma.user.updateMany({
    where: { id: current.id, deletedAt: null, ...(expected ? { updatedAt: user.updatedAt } : {}) },
    data: { firstName: firstCheck.value, lastName: lastCheck.value, name },
  });
  if (res.count === 0) return { ok: false, error: "Данные уже изменились. Обновите страницу." };

  await recordAudit({
    action: "account.profile_updated", entityType: "User", entityId: current.id, userId: current.id,
    metadata: { fields: ["firstName", "lastName", "name"] }, // never the values
  });
  revalidatePath("/settings/security");
  revalidatePath("/", "layout");
  return { ok: true };
}

// ============================ Password change ================================

type PwState = { ok: boolean; stage?: "form" | "otp" | "done"; error?: string };

async function loadAuthUser(id: string) {
  return prisma.user.findUnique({ where: { id }, select: { passwordHash: true, email: true, isActive: true, deletedAt: true } });
}

/** Step 1: verify current password + new-password policy, then send an OTP to
 * the CURRENT email (purpose change_password). The new password is NOT stored. */
export async function startPasswordChange(_prev: PwState | undefined, formData: FormData): Promise<PwState> {
  const current = await requireUser();
  if (!emailConfigured()) return { ok: false, stage: "form", error: EMAIL_DISABLED };

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  const user = await loadAuthUser(current.id);
  if (!user || user.deletedAt || !user.isActive) return { ok: false, stage: "form", error: "Аккаунт недоступен." };
  if (!user.passwordHash) return { ok: false, stage: "form", error: "Для этого аккаунта пароль не установлен. Сначала используйте предусмотренный системой способ создания пароля." };
  if (!(await verifyPassword(currentPassword, user.passwordHash))) return { ok: false, stage: "form", error: "Текущий пароль указан неверно." };

  const policy = validateNewPassword(newPassword, confirm, currentPassword);
  if (!policy.ok) return { ok: false, stage: "form", error: policy.error };

  const sent = await startActionChallenge({ userId: current.id, deliverTo: user.email, purpose: "change_password", kind: "change_password" });
  if (!sent.ok) return { ok: false, stage: sent.error === "rate" ? "form" : "otp", error: sent.error === "rate" ? "Слишком много попыток. Повторите позже." : "Почтовый сервис временно недоступен." };
  return { ok: true, stage: "otp" };
}

export async function resendPasswordOtp(): Promise<void> {
  const current = await requireUser();
  const user = await prisma.user.findUnique({ where: { id: current.id }, select: { email: true } });
  if (user) await startActionChallenge({ userId: current.id, deliverTo: user.email, purpose: "change_password", kind: "change_password" });
}

/** Step 2: verify OTP + re-check current password & policy, then update the hash
 * atomically and revoke OTHER sessions (current session preserved). */
export async function confirmPasswordChange(_prev: PwState | undefined, formData: FormData): Promise<PwState> {
  const current = await requireUser();
  const code = String(formData.get("code") ?? "").trim();
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  const verify = await verifyActionChallenge("change_password", code);
  if (!verify.ok) {
    if (verify.locked) return { ok: false, stage: "form", error: "Превышено количество попыток. Начните заново." };
    if (verify.expired) return { ok: false, stage: "form", error: "Срок действия кода истёк. Начните заново." };
    return { ok: false, stage: "otp", error: "Неверный код." };
  }
  if (verify.user && verify.user.id !== current.id) return { ok: false, stage: "form", error: "Сессия недействительна." };

  const user = await loadAuthUser(current.id);
  if (!user || user.deletedAt || !user.isActive || !user.passwordHash) return { ok: false, stage: "form", error: "Аккаунт недоступен." };
  if (!(await verifyPassword(currentPassword, user.passwordHash))) return { ok: false, stage: "form", error: "Текущий пароль указан неверно." };
  const policy = validateNewPassword(newPassword, confirm, currentPassword);
  if (!policy.ok) return { ok: false, stage: "form", error: policy.error };

  const newHash = await hashPassword(newPassword);
  const currentSessionId = await getCurrentSessionId();
  let revokedSessions = 0;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: current.id }, data: { passwordHash: newHash } });
    await revokeActionChallenges(current.id, "change_password", "consumed", tx);
    // Invalidate any pending login OTPs too (old auth material).
    await tx.emailOtpChallenge.updateMany({ where: { userId: current.id, purpose: "login", consumedAt: null, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "password_changed" } });
    revokedSessions = currentSessionId
      ? await revokeOtherSessions(current.id, currentSessionId, "password_changed", tx)
      : 0;
  });
  await clearActionCookie("change_password");
  await recordAudit({ action: "account.password_changed", entityType: "User", entityId: current.id, userId: current.id, metadata: { revokedSessionCount: revokedSessions } });
  revalidatePath("/settings/security");
  return { ok: true, stage: "done" };
}

// ============================ Email change (2-factor) =======================

type EmailState = { ok: boolean; stage?: "form" | "otp_current" | "otp_new" | "done"; error?: string; maskedNew?: string };

const EMAIL_CHANGE_COOKIE = "club_ops_email_change";
const isProd = process.env.NODE_ENV === "production";
function signEmailChange(userId: string, orig: string, next: string): string {
  return hashToken(`emailchange|${userId}|${orig}|${next}`);
}
async function setEmailChangeCookie(userId: string, orig: string, next: string): Promise<void> {
  const payload = Buffer.from(JSON.stringify({ o: orig, n: next })).toString("base64url");
  const store = await cookies();
  store.set(EMAIL_CHANGE_COOKIE, `${payload}.${signEmailChange(userId, orig, next)}`, {
    httpOnly: true, sameSite: "lax", secure: isProd, path: "/settings/security", expires: new Date(Date.now() + OTP_TTL_MS * 2),
  });
}
async function readEmailChangeCookie(userId: string): Promise<{ orig: string; next: string } | null> {
  const store = await cookies();
  const raw = store.get(EMAIL_CHANGE_COOKIE)?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot), sig = raw.slice(dot + 1);
  let data: { o?: unknown; n?: unknown };
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (typeof data.o !== "string" || typeof data.n !== "string") return null;
  if (signEmailChange(userId, data.o, data.n) !== sig) return null; // tamper / cross-user
  return { orig: data.o, next: data.n };
}
async function clearEmailChangeCookie(): Promise<void> {
  const store = await cookies();
  store.set(EMAIL_CHANGE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: isProd, path: "/settings/security", expires: new Date(0) });
}

/** A different ACTIVE user already holds this normalized email. */
async function emailTakenByOther(normalized: string, selfId: string): Promise<boolean> {
  const hit = await prisma.user.findFirst({ where: { email: normalized, id: { not: selfId }, deletedAt: null }, select: { id: true } });
  return hit !== null;
}

/** Stage 1: verify current password + new email, send OTP to the CURRENT email. */
export async function startEmailChange(_prev: EmailState | undefined, formData: FormData): Promise<EmailState> {
  const current = await requireUser();
  if (!emailConfigured()) return { ok: false, stage: "form", error: EMAIL_DISABLED };

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const user = await loadAuthUser(current.id);
  if (!user || user.deletedAt || !user.isActive) return { ok: false, stage: "form", error: "Аккаунт недоступен." };
  if (!user.passwordHash) return { ok: false, stage: "form", error: "Для этого аккаунта пароль не установлен." };
  if (!(await verifyPassword(currentPassword, user.passwordHash))) return { ok: false, stage: "form", error: "Текущий пароль указан неверно." };

  const emailCheck = validateNewEmail(String(formData.get("newEmail") ?? ""), user.email);
  if (!emailCheck.ok) return { ok: false, stage: "form", error: emailCheck.error };
  if (await emailTakenByOther(emailCheck.value, current.id)) return { ok: false, stage: "form", error: "Этот email уже используется." };

  await setEmailChangeCookie(current.id, normalizeEmail(user.email), emailCheck.value);
  const sent = await startActionChallenge({ userId: current.id, deliverTo: user.email, purpose: "change_email_current", kind: "change_email_current" });
  if (!sent.ok) return { ok: false, stage: sent.error === "rate" ? "form" : "otp_current", error: sent.error === "rate" ? "Слишком много попыток. Повторите позже." : "Почтовый сервис временно недоступен." };
  return { ok: true, stage: "otp_current" };
}

export async function resendEmailCurrentOtp(): Promise<void> {
  const current = await requireUser();
  const bind = await readEmailChangeCookie(current.id);
  const user = await prisma.user.findUnique({ where: { id: current.id }, select: { email: true } });
  if (bind && user) await startActionChallenge({ userId: current.id, deliverTo: user.email, purpose: "change_email_current", kind: "change_email_current" });
}

/** Stage 2: verify the CURRENT-email code, then send a SEPARATE code to the NEW email. */
export async function confirmEmailChangeCurrent(_prev: EmailState | undefined, formData: FormData): Promise<EmailState> {
  const current = await requireUser();
  const code = String(formData.get("code") ?? "").trim();
  const bind = await readEmailChangeCookie(current.id);
  if (!bind) return { ok: false, stage: "form", error: "Сеанс подтверждения истёк. Начните заново." };

  const verify = await verifyActionChallenge("change_email_current", code);
  if (!verify.ok) {
    if (verify.locked) return { ok: false, stage: "form", error: "Превышено количество попыток. Начните заново." };
    if (verify.expired) return { ok: false, stage: "form", error: "Срок действия кода истёк. Начните заново." };
    return { ok: false, stage: "otp_current", error: "Неверный код." };
  }
  if (verify.user && verify.user.id !== current.id) return { ok: false, stage: "form", error: "Сессия недействительна." };

  // Re-check target still free before issuing the second code.
  if (await emailTakenByOther(bind.next, current.id)) { await clearEmailChangeCookie(); return { ok: false, stage: "form", error: "Этот email уже используется." }; }

  const sent = await startActionChallenge({ userId: current.id, deliverTo: bind.next, purpose: "change_email_new", kind: "change_email_new" });
  if (!sent.ok) return { ok: false, stage: sent.error === "rate" ? "otp_current" : "otp_new", error: sent.error === "rate" ? "Слишком много попыток. Повторите позже." : "Почтовый сервис временно недоступен." };
  return { ok: true, stage: "otp_new", maskedNew: maskEmail(bind.next) };
}

export async function resendEmailNewOtp(): Promise<void> {
  const current = await requireUser();
  const bind = await readEmailChangeCookie(current.id);
  if (bind) await startActionChallenge({ userId: current.id, deliverTo: bind.next, purpose: "change_email_new", kind: "change_email_new" });
}

/** Stage 3: verify the NEW-email code and finalize the change atomically. */
export async function confirmEmailChangeNew(_prev: EmailState | undefined, formData: FormData): Promise<EmailState> {
  const current = await requireUser();
  const code = String(formData.get("code") ?? "").trim();
  const bind = await readEmailChangeCookie(current.id);
  if (!bind) return { ok: false, stage: "form", error: "Сеанс подтверждения истёк. Начните заново." };

  const verify = await verifyActionChallenge("change_email_new", code);
  if (!verify.ok) {
    if (verify.locked) return { ok: false, stage: "form", error: "Превышено количество попыток. Начните заново." };
    if (verify.expired) return { ok: false, stage: "form", error: "Срок действия кода истёк. Начните заново." };
    return { ok: false, stage: "otp_new", error: "Неверный код." };
  }
  if (verify.user && verify.user.id !== current.id) return { ok: false, stage: "form", error: "Сессия недействительна." };

  const currentSessionId = await getCurrentSessionId();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: current.id }, select: { email: true, isActive: true, deletedAt: true } });
      if (!user || user.deletedAt || !user.isActive) return { kind: "gone" as const };
      // The account email must not have changed since this flow started.
      if (normalizeEmail(user.email) !== bind.orig) return { kind: "stale" as const };
      // Final uniqueness re-check (someone may have taken it mid-flow).
      const taken = await tx.user.findFirst({ where: { email: bind.next, id: { not: current.id }, deletedAt: null }, select: { id: true } });
      if (taken) return { kind: "taken" as const };

      await tx.user.update({ where: { id: current.id }, data: { email: bind.next, emailVerifiedAt: new Date() } });
      await revokeActionChallenges(current.id, "change_email_current", "consumed", tx);
      await revokeActionChallenges(current.id, "change_email_new", "consumed", tx);
      await tx.emailOtpChallenge.updateMany({ where: { userId: current.id, purpose: "login", consumedAt: null, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "email_changed" } });
      const revoked = currentSessionId ? await revokeOtherSessions(current.id, currentSessionId, "email_changed", tx) : 0;
      return { kind: "ok" as const, revoked };
    });

    if (result.kind === "gone") return { ok: false, stage: "form", error: "Аккаунт недоступен." };
    if (result.kind === "stale") { await clearEmailChangeCookie(); return { ok: false, stage: "form", error: "Данные уже изменились. Обновите страницу." }; }
    if (result.kind === "taken") { await clearEmailChangeCookie(); return { ok: false, stage: "form", error: "Этот email уже используется." }; }

    await clearEmailChangeCookie();
    await recordAudit({ action: "account.email_changed", entityType: "User", entityId: current.id, userId: current.id, metadata: { revokedSessionCount: result.revoked } });
    revalidatePath("/settings/security");
    revalidatePath("/", "layout");
    return { ok: true, stage: "done" };
  } catch {
    return { ok: false, stage: "form", error: "Не удалось изменить email. Изменения не применены." };
  }
}

/** Cancel any in-flight email change (clears cookie + challenges). */
export async function cancelEmailChange(): Promise<void> {
  const current = await requireUser();
  await revokeActionChallenges(current.id, "change_email_current", "canceled");
  await revokeActionChallenges(current.id, "change_email_new", "canceled");
  await clearActionCookie("change_email_current");
  await clearActionCookie("change_email_new");
  await clearEmailChangeCookie();
}
