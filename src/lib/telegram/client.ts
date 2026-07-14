// Server-only Telegram Bot API client. Sends PLAIN-TEXT messages (no Markdown, so
// no escaping bugs) with an optional single inline "Открыть в CLUB-OPS" button.
// The bot token is read from env and NEVER logged. Returns a discriminated result
// the outbox uses to decide retry/skip/block — the message text is never logged.
import { telegramBotToken, TELEGRAM_SEND_TIMEOUT_MS } from "@/lib/telegram/config";

export type TelegramSendResult =
  | { ok: true }
  | {
      ok: false;
      code: "not_configured" | "http_400" | "blocked" | "rate_limited" | "server" | "http" | "network" | "timeout";
      httpStatus?: number;
      retryAfterSec?: number;
    };

export type TelegramSendOptions = { openUrl?: string; openLabel?: string };

function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/**
 * Send a plain-text Telegram message. `openUrl` adds one inline URL button.
 * Never throws; returns a typed result. The token/text are not logged here.
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  opts?: TelegramSendOptions,
): Promise<TelegramSendResult> {
  const token = telegramBotToken();
  if (!token) return { ok: false, code: "not_configured" };

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (opts?.openUrl) {
    body.reply_markup = {
      inline_keyboard: [[{ text: opts.openLabel ?? "Открыть в CLUB-OPS", url: opts.openUrl }]],
    };
  }

  let res: Response;
  try {
    res = await fetch(apiUrl(token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, code: timedOut ? "timeout" : "network" };
  }

  if (res.ok) return { ok: true };

  if (res.status === 429) {
    let retryAfterSec: number | undefined;
    try {
      const data = (await res.json()) as { parameters?: { retry_after?: number } };
      retryAfterSec = data?.parameters?.retry_after;
    } catch {
      /* ignore body parse errors — the status is enough */
    }
    return { ok: false, code: "rate_limited", httpStatus: 429, retryAfterSec };
  }
  // 403 = bot blocked / user deactivated → stop sending to this chat.
  if (res.status === 403) return { ok: false, code: "blocked", httpStatus: 403 };
  if (res.status === 400) return { ok: false, code: "http_400", httpStatus: 400 };
  if (res.status >= 500) return { ok: false, code: "server", httpStatus: res.status };
  return { ok: false, code: "http", httpStatus: res.status };
}

/** Reply to a webhook message (no button). Best-effort — errors are swallowed. */
export async function answerTelegramWebhookMessage(chatId: string, text: string): Promise<void> {
  try {
    await sendTelegramMessage(chatId, text);
  } catch {
    /* webhook replies are best-effort */
  }
}
