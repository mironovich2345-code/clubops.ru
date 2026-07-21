"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createLinkCodeForUser, unlinkTelegramForUser } from "@/lib/telegram/linking";
import { telegramBotUsername, telegramEnabled } from "@/lib/telegram/config";
import { isRateLimited, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";

type LinkState = { ok: boolean; error?: string; code?: string; startUrl?: string; expiresAt?: string };

/** Create a one-time Telegram link code for the CURRENT user only. */
export async function createTelegramLinkCode(_prev: LinkState | undefined): Promise<LinkState> {
  const user = await requireUser();
  if (!telegramEnabled()) return { ok: false, error: "Telegram-уведомления сейчас недоступны." };
  // Cap link-code creation per user (5/hour). The single-active-code + TTL invariant
  // in linking.ts is preserved.
  if (await isRateLimited("telegram_link", "user", user.id)) return { ok: false, error: RATE_LIMIT_MESSAGE };
  try {
    const { code, expiresAt } = await createLinkCodeForUser(user.id);
    const username = telegramBotUsername();
    const startUrl = username ? `https://t.me/${username}?start=${code}` : undefined;
    revalidatePath("/settings/security");
    return { ok: true, code, startUrl, expiresAt: expiresAt.toISOString() };
  } catch (error) {
    console.error("createTelegramLinkCode failed", error instanceof Error ? error.message : error);
    return { ok: false, error: "Не удалось создать код. Повторите попытку." };
  }
}

/** Unlink the CURRENT user's own Telegram connection. */
export async function unlinkTelegram(): Promise<void> {
  const user = await requireUser();
  await unlinkTelegramForUser(user.id);
  revalidatePath("/settings/security");
}
