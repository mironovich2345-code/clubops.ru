"use server";

import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/safe-redirect";
import {
  verifyCurrentChallenge,
  resendCurrentChallenge,
  clearChallengeCookie,
} from "@/lib/login-challenge";

type State = { ok: boolean; error?: string; info?: string };

/** STEP 2: verify the OTP. On success the Session is created and we redirect. */
export async function verifyOtpAction(_prev: State | undefined, formData: FormData): Promise<State> {
  const code = String(formData.get("code") ?? "").replace(/\D/g, "");
  const next = safeNextPath(String(formData.get("next") ?? ""));
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "Введите шестизначный код" };
  }

  const result = await verifyCurrentChallenge(code);
  if (result.ok) {
    redirect(next);
  }
  if (result.expired) {
    redirect("/login?e=expired");
  }
  if (result.locked) {
    redirect("/login?e=locked");
  }
  return { ok: false, error: "Неверный или просроченный код" };
}

export async function resendOtpAction(_prev: State | undefined): Promise<State> {
  const result = await resendCurrentChallenge();
  if (result.ok) return { ok: true, info: "Новый код отправлен" };
  if (result.expired) redirect("/login?e=expired");
  if (result.error === "cooldown") return { ok: false, error: "Подождите перед повторной отправкой" };
  if (result.error === "rate") return { ok: false, error: "Слишком много отправок. Повторите позже." };
  return { ok: false, error: "Не удалось отправить код. Повторите попытку позже." };
}

/** Return to the password step: drop the temporary challenge cookie. */
export async function restartLoginAction(): Promise<void> {
  await clearChallengeCookie();
  redirect("/login");
}
