"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  verifyLoginPassword,
  signOut,
  hashPassword,
  MIN_PASSWORD_LENGTH,
} from "@/lib/auth";
import { startLoginChallenge } from "@/lib/login-challenge";
import { recordAudit } from "@/lib/access";
import { isFirstUser, setupDemoCompanyForOwner } from "@/lib/seed";
import { safeNextPath } from "@/lib/safe-redirect";
import { checkRateLimit, peekRateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request-ip";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Not exported: a "use server" module may only export async functions. The
// client infers this shape from the action signatures.
type AuthFormState = { ok: boolean; error?: string };

export async function loginAction(
  _prev: AuthFormState | undefined,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!EMAIL_RE.test(email)) return { ok: false, error: "Введите корректный email" };
  if (!password) return { ok: false, error: "Введите пароль" };

  // Rate limiting (fail-closed on abuse, generic message — no account enumeration):
  //  - per-IP: caps ALL login attempts (records this attempt);
  //  - per-account: caps FAILED attempts only (peeked here, recorded on failure),
  //    so a legitimate repeated login never locks the account.
  const ip = await getClientIp();
  const ipLimit = await checkRateLimit("login", "ip", ip);
  if (!ipLimit.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };
  const emailFailures = await peekRateLimit("login", "email", email);
  if (emailFailures.limited) return { ok: false, error: RATE_LIMIT_MESSAGE };

  // STEP 1: password only — never creates a Session.
  const result = await verifyLoginPassword(email, password);
  if (!result.ok) {
    // Count the failure toward the per-account cap (never logs the raw email).
    await checkRateLimit("login", "email", email);
    return { ok: false, error: result.error };
  }
  await recordAudit({ action: "auth.password_verified", entityType: "User", entityId: result.user.id, userId: result.user.id });

  // STEP 2: create + email an OTP challenge; the Session is created only after
  // the code is verified on /login/verify.
  const next = safeNextPath(String(formData.get("next") ?? ""));
  const challenge = await startLoginChallenge(result.user);
  const verifyUrl = `/login/verify${next && next !== "/dashboard" ? `?next=${encodeURIComponent(next)}` : ""}`;
  if (!challenge.ok && !challenge.created) {
    // Could not even create a challenge (e.g. hourly send ceiling).
    return { ok: false, error: "Слишком много попыток входа. Повторите позже." };
  }
  redirect(challenge.ok ? verifyUrl : `${verifyUrl}${verifyUrl.includes("?") ? "&" : "?"}e=send`);
}

export async function registerAction(
  _prev: AuthFormState | undefined,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();

  if (!EMAIL_RE.test(email)) return { ok: false, error: "Введите корректный email" };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов` };
  }

  // Per-IP registration cap — bounds mass account creation + OTP-email amplification
  // BEFORE any DB write or email is triggered. Generic message (no enumeration).
  const ip = await getClientIp();
  if (!(await checkRateLimit("register", "ip", ip)).allowed) {
    return { ok: false, error: RATE_LIMIT_MESSAGE };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { ok: false, error: "Пользователь с таким email уже существует" };

  const first = await isFirstUser();
  const passwordHash = await hashPassword(password);
  const name = [firstName, lastName].filter(Boolean).join(" ") || email;

  const user = await prisma.user.create({
    data: {
      email,
      name,
      firstName: firstName || null,
      lastName: lastName || null,
      role: "owner",
      passwordHash,
      isActive: true,
    },
  });

  // The first user in the system bootstraps the demo company and becomes its
  // owner; later registrants start without a company (empty state) until invited.
  if (first) {
    await setupDemoCompanyForOwner(user.id);
  }

  // No Session on registration — the user must complete email OTP. Start the
  // challenge and route to the verify page (carrying a safe return URL).
  const next = safeNextPath(String(formData.get("next") ?? ""));
  const challenge = await startLoginChallenge({ id: user.id, email: user.email, isActive: user.isActive });
  const verifyUrl = `/login/verify${next && next !== "/dashboard" ? `?next=${encodeURIComponent(next)}` : ""}`;
  if (!challenge.ok && !challenge.created) {
    return { ok: false, error: "Не удалось отправить код. Повторите попытку позже." };
  }
  redirect(challenge.ok ? verifyUrl : `${verifyUrl}${verifyUrl.includes("?") ? "&" : "?"}e=send`);
}

export async function logoutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}
