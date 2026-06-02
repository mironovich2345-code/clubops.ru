"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  signIn,
  signOut,
  hashPassword,
  createSession,
  MIN_PASSWORD_LENGTH,
} from "@/lib/auth";
import { isFirstUser, setupDemoCompanyForOwner } from "@/lib/seed";

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

  const result = await signIn(email, password);
  if (!result.ok) return { ok: false, error: result.error ?? "Не удалось войти" };

  redirect("/dashboard");
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

  await createSession(user.id);
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}
