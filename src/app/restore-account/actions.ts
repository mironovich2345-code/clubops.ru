"use server";

import { redirect } from "next/navigation";
import { recordAudit } from "@/lib/access";
import { startActionChallenge, verifyActionChallenge, clearActionCookie } from "@/lib/action-challenge";
import { lookupByRecoveryToken, finalizeRestore, EMAIL_REUSE_MESSAGE } from "@/lib/account-restore";

type State = { ok: boolean; stage?: "start" | "otp"; error?: string; masked?: string };

const GENERIC = "Ссылка восстановления недействительна или истекла.";

/** Step 1: validate the recovery token and email a restore OTP to the ORIGINAL address. */
export async function startRestore(_prev: State | undefined, formData: FormData): Promise<State> {
  const token = String(formData.get("token") ?? "").trim();
  const lookup = await lookupByRecoveryToken(token);
  if (!lookup.ok) {
    if (lookup.code === "reused") return { ok: false, stage: "start", error: EMAIL_REUSE_MESSAGE };
    return { ok: false, stage: "start", error: GENERIC };
  }
  await recordAudit({ action: "account.restore_started", entityType: "User", entityId: lookup.userId, userId: lookup.userId, metadata: { via: "recovery_token" } });
  const sent = await startActionChallenge({ userId: lookup.userId, deliverTo: lookup.originalEmail, purpose: "account_restore", kind: "restore" });
  if (!sent.ok) return { ok: false, stage: "start", error: "Не удалось отправить код. Повторите попытку позже.", masked: lookup.maskedEmail };
  return { ok: true, stage: "otp", masked: lookup.maskedEmail };
}

/** Step 2: verify the restore OTP + set a new password. Never creates a Session. */
export async function confirmRestore(_prev: State | undefined, formData: FormData): Promise<State> {
  const token = String(formData.get("token") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  const newPassword = String(formData.get("password") ?? "");

  const verify = await verifyActionChallenge("account_restore", code);
  if (!verify.ok) {
    if (verify.locked || verify.expired) return { ok: false, stage: "start", error: "Сеанс подтверждения истёк. Начните заново." };
    return { ok: false, stage: "otp", error: "Неверный или просроченный код." };
  }

  const result = await finalizeRestore({ token, newPassword });
  if (!result.ok) {
    await clearActionCookie("account_restore");
    return { ok: false, stage: result.code === "weak_password" ? "otp" : "start", error: result.error };
  }
  await clearActionCookie("account_restore");
  // Ordinary login (password + mandatory OTP) is required — no Session created.
  redirect("/login?restored=1");
}
