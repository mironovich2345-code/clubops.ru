import { randomBytes } from "node:crypto";
import { hashToken } from "@/lib/auth";

export const INVITE_TTL_DAYS = 7;

/** Creates a raw token (shown once) and its stored hash. */
export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export function hashInviteToken(token: string): string {
  return hashToken(token);
}

export function inviteExpiry(): Date {
  return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function isInviteExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() < Date.now();
}

// Roles assigned at club level (manager). Everything else is company level.
export function isClubScopedRole(role: string): boolean {
  return role === "manager";
}

export const INVITE_ROLE_LABELS: Record<string, string> = {
  owner: "Собственник",
  general_director: "Ген.директор",
  regional_director: "Региональный директор",
  manager: "Управляющий",
  chief_accountant: "Главный бухгалтер",
  accountant: "Бухгалтер",
  marketer: "Маркетолог",
};

// --- Resend / regenerate rate limiting (Block A4) --------------------------
// Applied to every token rotation (resend email + regenerate link). Enforced on
// the server via an optimistic compare-and-set so concurrent double-clicks can
// never both pass.
export const INVITE_RESEND_COOLDOWN_MS = 60 * 1000; // 60s between rotations
export const INVITE_SEND_WINDOW_MS = 24 * 60 * 60 * 1000; // rolling 24h window
export const INVITE_MAX_SENDS_PER_WINDOW = 5; // max rotations per 24h

export type SendGateInput = {
  lastSentAt: Date | null;
  sendWindowStartedAt: Date | null;
  sendCountInWindow: number;
  now: Date;
};

export type SendGate =
  | { ok: true; windowStartedAt: Date; countInWindow: number }
  | { ok: false; reason: "cooldown" | "rate" };

/**
 * Pure decision for whether a token rotation is allowed now, and the window
 * counters to persist if it is. Resets the window lazily once 24h have elapsed.
 */
export function evaluateSendGate(i: SendGateInput): SendGate {
  if (i.lastSentAt && i.now.getTime() - i.lastSentAt.getTime() < INVITE_RESEND_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown" };
  }
  let windowStart = i.sendWindowStartedAt;
  let count = i.sendCountInWindow;
  if (!windowStart || i.now.getTime() - windowStart.getTime() >= INVITE_SEND_WINDOW_MS) {
    windowStart = i.now;
    count = 0;
  }
  if (count >= INVITE_MAX_SENDS_PER_WINDOW) return { ok: false, reason: "rate" };
  return { ok: true, windowStartedAt: windowStart, countInWindow: count + 1 };
}

// --- Derived status (Block A7) ---------------------------------------------
export type InviteStatus =
  | "accepted"
  | "revoked"
  | "expired"
  | "email_failed"
  | "email_sent"
  | "pending";

export function deriveInviteStatus(inv: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  emailDeliveryStatus: string | null;
}): InviteStatus {
  if (inv.acceptedAt) return "accepted";
  if (inv.revokedAt) return "revoked";
  if (isInviteExpired(inv.expiresAt)) return "expired";
  if (inv.emailDeliveryStatus === "failed") return "email_failed";
  if (inv.emailDeliveryStatus === "sent") return "email_sent";
  return "pending";
}

export const INVITE_STATUS_LABELS: Record<InviteStatus, string> = {
  accepted: "Принято",
  revoked: "Отозвано",
  expired: "Истекло",
  email_failed: "Письмо не отправлено",
  email_sent: "Письмо отправлено",
  pending: "Ожидает регистрации",
};
