// Durable notification outbox. A business action enqueues a row AFTER its status
// change commits; a separate drain (cron / endpoint) delivers it. A Telegram
// failure never affects the business action. Only safe payloads are stored, and
// neither the message text nor the chat id is ever logged.
import { prisma } from "@/lib/prisma";
import { telegramConfigured, NOTIFICATION_MAX_ATTEMPTS } from "@/lib/telegram/config";
import { sendTelegramMessage } from "@/lib/telegram/client";
import { getActiveChatId } from "@/lib/telegram/linking";
import { buildTelegramMessage, type NotificationPayload } from "@/lib/notifications/telegram";

export type EnqueueParams = {
  type: string;
  recipientUserId: string;
  resourceType: "expense" | "invoice" | "refund";
  resourceId: string;
  companyId: string;
  clubId: string | null;
  payload: NotificationPayload;
};

/** Insert a pending outbox row (safe payload only). Callers wrap this in their own
 * try/catch so a failure here never breaks the business action. */
export async function enqueueNotification(params: EnqueueParams): Promise<void> {
  await prisma.notificationOutbox.create({
    data: {
      channel: "telegram",
      type: params.type,
      recipientUserId: params.recipientUserId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      companyId: params.companyId,
      clubId: params.clubId,
      payloadJson: JSON.stringify(params.payload),
      status: "pending",
      nextAttemptAt: new Date(),
    },
  });
}

export type DrainCounts = { processed: number; sent: number; skipped: number; failed: number };

/** Exponential backoff (capped at 30 min); honours Telegram retry_after. */
function backoffMs(attempts: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) return retryAfterSec * 1000;
  return Math.min(30_000 * 2 ** attempts, 30 * 60_000);
}

/**
 * Deliver a batch of due notifications. Returns COUNTS only (never text/chatId).
 * No-ops when Telegram is not enabled/configured (rows stay pending for later).
 */
export async function drainNotificationOutbox(limit = 25): Promise<DrainCounts> {
  const counts: DrainCounts = { processed: 0, sent: 0, skipped: 0, failed: 0 };
  if (!telegramConfigured()) return counts;

  const now = new Date();
  const due = await prisma.notificationOutbox.findMany({
    where: { status: "pending", channel: "telegram", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  for (const row of due) {
    // Claim the row (compare-and-set) so parallel drains never double-send.
    const claimed = await prisma.notificationOutbox.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "sending" },
    });
    if (claimed.count !== 1) continue;
    counts.processed += 1;

    const chatId = await getActiveChatId(row.recipientUserId);
    if (!chatId) {
      await prisma.notificationOutbox.update({ where: { id: row.id }, data: { status: "skipped", lastErrorCode: "no_connection" } });
      counts.skipped += 1;
      continue;
    }

    let payload: NotificationPayload;
    try {
      payload = JSON.parse(row.payloadJson) as NotificationPayload;
    } catch {
      await prisma.notificationOutbox.update({ where: { id: row.id }, data: { status: "failed", lastErrorCode: "bad_payload" } });
      counts.failed += 1;
      continue;
    }

    const msg = buildTelegramMessage(row.type, row.resourceId, payload);
    const result = await sendTelegramMessage(chatId, msg.text, msg.openUrl ? { openUrl: msg.openUrl } : undefined);

    if (result.ok) {
      await prisma.notificationOutbox.update({ where: { id: row.id }, data: { status: "sent", sentAt: new Date(), lastErrorCode: null } });
      counts.sent += 1;
      continue;
    }

    // 403 → the bot is blocked / user deactivated: stop sending to this chat.
    if (result.code === "blocked") {
      await prisma.telegramConnection.updateMany({ where: { chatId, isActive: true }, data: { isActive: false, blockedAt: new Date() } });
      await prisma.notificationOutbox.update({ where: { id: row.id }, data: { status: "skipped", lastErrorCode: "blocked" } });
      counts.skipped += 1;
      continue;
    }

    // A malformed request will not fix itself → permanent failure.
    if (result.code === "http_400") {
      await prisma.notificationOutbox.update({ where: { id: row.id }, data: { status: "failed", lastErrorCode: "http_400", attempts: { increment: 1 } } });
      counts.failed += 1;
      continue;
    }

    // Retryable (429 / server / network / timeout / other http): backoff or fail
    // after the attempt ceiling.
    const attempts = row.attempts + 1;
    const retryAfterSec = result.code === "rate_limited" ? result.retryAfterSec : undefined;
    if (attempts >= NOTIFICATION_MAX_ATTEMPTS) {
      await prisma.notificationOutbox.update({ where: { id: row.id }, data: { status: "failed", attempts, lastErrorCode: result.code } });
      counts.failed += 1;
    } else {
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: { status: "pending", attempts, lastErrorCode: result.code, nextAttemptAt: new Date(Date.now() + backoffMs(attempts, retryAfterSec)) },
      });
    }
  }

  return counts;
}
