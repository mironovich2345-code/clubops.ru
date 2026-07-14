// Server-only Telegram configuration. Reads ONLY from env; the bot token and
// webhook secret are never returned to callers, logged, or exposed in health.
// Notifications are OFF by default — everything below no-ops unless explicitly
// enabled AND configured, so business flows are never affected.

export function telegramEnabled(): boolean {
  return process.env.TELEGRAM_NOTIFICATIONS_ENABLED === "true";
}

export function telegramBotToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

export function telegramBotUsername(): string | null {
  return process.env.TELEGRAM_BOT_USERNAME || null;
}

export function telegramWebhookSecret(): string | null {
  return process.env.TELEGRAM_WEBHOOK_SECRET || null;
}

export function notificationDrainSecret(): string | null {
  return process.env.NOTIFICATION_DRAIN_SECRET || null;
}

/** Enabled AND a bot token present — only then may a real message be sent. */
export function telegramConfigured(): boolean {
  return telegramEnabled() && Boolean(telegramBotToken());
}

/** Safe, value-free status for /api/health (never leaks the token/secret). */
export function telegramHealth(): { enabled: boolean; configured: boolean } {
  return { enabled: telegramEnabled(), configured: telegramConfigured() };
}

export const TELEGRAM_LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const TELEGRAM_LINK_MAX_ATTEMPTS = 5;
export const NOTIFICATION_MAX_ATTEMPTS = 5;
export const TELEGRAM_SEND_TIMEOUT_MS = 12_000;
