// Server-only Telegram account-linking service. The raw start-link code is shown
// once and NEVER stored — only its HMAC hash (keyed by SESSION_SECRET, shared
// with sessions/invites). Enforces: exactly one ACTIVE connection per user and
// per chat, 10-minute single-use codes, max 5 attempts. Audit events never carry
// the raw code, the hash, or the webhook payload.
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/tokens";
import { recordAudit } from "@/lib/access";
import { TELEGRAM_LINK_CODE_TTL_MS, TELEGRAM_LINK_MAX_ATTEMPTS } from "@/lib/telegram/config";

/** Raw code (URL-safe for the t.me ?start= param) + its stored HMAC hash. */
export function generateLinkCode(): { code: string; codeHash: string } {
  const code = randomBytes(24).toString("base64url"); // 32 chars, [A-Za-z0-9_-]
  return { code, codeHash: hashToken(code) };
}

/**
 * Create a fresh one-time link code for a user, invalidating any earlier unused
 * codes. Returns the RAW code once (never stored). Caller shows it + the t.me
 * link. Only the current user may create their own code (enforced by the action).
 */
export async function createLinkCodeForUser(userId: string): Promise<{ code: string; expiresAt: Date }> {
  const now = new Date();
  // Invalidate any earlier unused codes for this user (single active code).
  await prisma.telegramLinkCode.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: now },
  });
  const { code, codeHash } = generateLinkCode();
  const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_CODE_TTL_MS);
  await prisma.telegramLinkCode.create({ data: { userId, codeHash, expiresAt } });
  await recordAudit({ action: "telegram.link_code_created", entityType: "TelegramLinkCode", userId, metadata: {} });
  return { code, expiresAt };
}

export type LinkOutcome =
  | { ok: true; replacedPrevious: boolean }
  | { ok: false; reason: "invalid_or_expired" | "chat_taken" | "user_inactive" };

type ChatInfo = { chatId: string; username?: string | null; firstName?: string | null; lastName?: string | null };

/**
 * Apply a start-link code coming from the Telegram webhook. Single-use + attempt
 * limited, transactional so a double /start never creates a duplicate:
 *  - the code is flipped to used only if still valid (compare-and-set);
 *  - the chat cannot already belong to a different active user;
 *  - the user's previous active connection is deactivated, then the new one is
 *    created (or reactivated for the same chat).
 */
export async function consumeLinkCode(rawCode: string, chat: ChatInfo): Promise<LinkOutcome> {
  const codeHash = hashToken(rawCode);
  const now = new Date();
  const code = await prisma.telegramLinkCode.findUnique({ where: { codeHash } });

  // Unknown / already used / expired / too many attempts → count an attempt (if
  // the row exists) and refuse. Never reveal which condition failed.
  if (!code || code.usedAt || code.expiresAt <= now || code.attempts >= TELEGRAM_LINK_MAX_ATTEMPTS) {
    if (code && !code.usedAt) {
      await prisma.telegramLinkCode.update({
        where: { id: code.id },
        data: { attempts: { increment: 1 }, lastAttemptAt: now },
      });
    }
    await recordAudit({ action: "telegram.link_failed", entityType: "TelegramLinkCode", userId: code?.userId ?? null, metadata: { reason: "invalid_or_expired" } });
    return { ok: false, reason: "invalid_or_expired" };
  }

  const user = await prisma.user.findUnique({ where: { id: code.userId }, select: { isActive: true, deletedAt: true } });
  if (!user || !user.isActive || user.deletedAt) {
    await prisma.telegramLinkCode.update({ where: { id: code.id }, data: { attempts: { increment: 1 }, lastAttemptAt: now } });
    await recordAudit({ action: "telegram.link_failed", entityType: "TelegramLinkCode", userId: code.userId, metadata: { reason: "user_inactive" } });
    return { ok: false, reason: "user_inactive" };
  }

  // The chat must not be actively linked to a DIFFERENT user.
  const chatOwner = await prisma.telegramConnection.findFirst({
    where: { chatId: chat.chatId, isActive: true },
    select: { userId: true },
  });
  if (chatOwner && chatOwner.userId !== code.userId) {
    await prisma.telegramLinkCode.update({ where: { id: code.id }, data: { attempts: { increment: 1 }, lastAttemptAt: now } });
    await recordAudit({ action: "telegram.link_failed", entityType: "TelegramLinkCode", userId: code.userId, metadata: { reason: "chat_taken" } });
    return { ok: false, reason: "chat_taken" };
  }

  let replacedPrevious = false;
  try {
    replacedPrevious = await prisma.$transaction(async (tx) => {
      // Single-use gate: flip the code only if still valid. Loser of a double
      // /start updates 0 rows and does nothing further.
      const cas = await tx.telegramLinkCode.updateMany({
        where: { id: code.id, usedAt: null, expiresAt: { gt: now }, attempts: { lt: TELEGRAM_LINK_MAX_ATTEMPTS } },
        data: { usedAt: now, consumedByChatId: chat.chatId },
      });
      if (cas.count !== 1) return false;

      // Deactivate the user's other active connections (max one active per user).
      const deactivated = await tx.telegramConnection.updateMany({
        where: { userId: code.userId, isActive: true, chatId: { not: chat.chatId } },
        data: { isActive: false, unlinkedAt: now },
      });

      // Reactivate the same (user, chat) row if it exists; else create it.
      const existing = await tx.telegramConnection.findFirst({
        where: { userId: code.userId, chatId: chat.chatId },
        select: { id: true },
      });
      if (existing) {
        await tx.telegramConnection.update({
          where: { id: existing.id },
          data: { isActive: true, unlinkedAt: null, blockedAt: null, linkedAt: now, lastSeenAt: now, username: chat.username ?? null, firstName: chat.firstName ?? null, lastName: chat.lastName ?? null },
        });
      } else {
        await tx.telegramConnection.create({
          data: { userId: code.userId, chatId: chat.chatId, username: chat.username ?? null, firstName: chat.firstName ?? null, lastName: chat.lastName ?? null, isActive: true, linkedAt: now, lastSeenAt: now },
        });
      }
      return deactivated.count > 0;
    });
  } catch {
    return { ok: false, reason: "invalid_or_expired" };
  }

  await recordAudit({ action: "telegram.linked", entityType: "TelegramConnection", userId: code.userId, metadata: { replacedPrevious } });
  return { ok: true, replacedPrevious };
}

/** Deactivate the user's active Telegram connection(s). History is preserved. */
export async function unlinkTelegramForUser(userId: string): Promise<boolean> {
  const res = await prisma.telegramConnection.updateMany({
    where: { userId, isActive: true },
    data: { isActive: false, unlinkedAt: new Date() },
  });
  if (res.count > 0) {
    await recordAudit({ action: "telegram.unlinked", entityType: "TelegramConnection", userId, metadata: {} });
  }
  return res.count > 0;
}

export type TelegramConnectionView = {
  connected: boolean;
  username: string | null;
  linkedAt: Date | null;
};

/** The user's active connection for the security page (no chatId exposed). */
export async function getActiveConnectionView(userId: string): Promise<TelegramConnectionView> {
  const c = await prisma.telegramConnection.findFirst({
    where: { userId, isActive: true },
    select: { username: true, linkedAt: true },
    orderBy: { linkedAt: "desc" },
  });
  return { connected: Boolean(c), username: c?.username ?? null, linkedAt: c?.linkedAt ?? null };
}

/** Active chat id for delivery (outbox). Never exposed to the client. */
export async function getActiveChatId(userId: string): Promise<string | null> {
  const c = await prisma.telegramConnection.findFirst({
    where: { userId, isActive: true },
    select: { chatId: true },
    orderBy: { linkedAt: "desc" },
  });
  return c?.chatId ?? null;
}
