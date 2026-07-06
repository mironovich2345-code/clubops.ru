// Sensitive-action email-OTP challenges (account deletion / restoration).
// SEPARATE from the login challenge: a fresh code is required for the specific
// destructive action, and verifying it NEVER creates a Session — the caller
// performs the action after a verified challenge. Reuses EmailOtpChallenge with
// a distinct `purpose` and its own opaque cookie. The OTP is never stored or
// logged in plaintext (HMAC digest via lib/otp).
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import type { EmailOtpChallenge, Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/tokens";
import { recordAudit } from "@/lib/access";
import { sendActionOtpEmail } from "@/lib/email";
import {
  generateOtp, otpDigest, verifyOtp, maskEmail,
  OTP_TTL_MS, OTP_RESEND_COOLDOWN_MS, OTP_MAX_SENDS_PER_HOUR,
} from "@/lib/otp";

type Db = typeof prisma | Prisma.TransactionClient;

export type ActionPurpose = "account_deletion" | "owner_delete" | "account_restore" | "account_restore_admin";
type Kind = "deletion" | "restore";

const EXPIRES_MINUTES = Math.round(OTP_TTL_MS / 60000);
const newRequestId = () => randomBytes(8).toString("hex");
const isDeletionPurpose = (p: ActionPurpose) => p === "account_deletion" || p === "owner_delete";

function cookieFor(purpose: ActionPurpose): { name: string; path: string } {
  if (purpose === "account_deletion") return { name: "club_ops_delete_challenge", path: "/settings/security" };
  if (purpose === "owner_delete") return { name: "club_ops_owner_delete_challenge", path: "/users" };
  if (purpose === "account_restore_admin") return { name: "club_ops_admin_restore_challenge", path: "/system-admin" };
  return { name: "club_ops_restore_challenge", path: "/restore-account" };
}

async function setCookie(purpose: ActionPurpose, token: string, expiresAt: Date): Promise<void> {
  const { name, path } = cookieFor(purpose);
  const store = await cookies();
  store.set(name, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path, expires: expiresAt });
}

export async function clearActionCookie(purpose: ActionPurpose): Promise<void> {
  const { name, path } = cookieFor(purpose);
  const store = await cookies();
  store.set(name, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path, expires: new Date(0) });
}

async function sendsInLastHour(userId: string, purpose: ActionPurpose): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await prisma.emailOtpChallenge.findMany({ where: { userId, purpose, lastSentAt: { gte: since } }, select: { sendCount: true } });
  return rows.reduce((s, r) => s + r.sendCount, 0);
}

export type StartResult = { ok: boolean; created: boolean; error?: string };

/**
 * Begin a sensitive-action challenge for `userId`, delivering the code to
 * `deliverTo` (the current email for deletion, the decrypted original email for
 * restoration). Supersedes prior unconsumed challenges of the SAME purpose.
 */
export async function startActionChallenge(opts: {
  userId: string; deliverTo: string; purpose: ActionPurpose; kind: Kind;
}): Promise<StartResult> {
  const { userId, deliverTo, purpose, kind } = opts;
  if ((await sendsInLastHour(userId, purpose)) >= OTP_MAX_SENDS_PER_HOUR) {
    await recordAudit({ action: "auth.otp_resend_blocked", entityType: "User", entityId: userId, userId, metadata: { reason: "hourly_limit", purpose } });
    return { ok: false, created: false, error: "rate" };
  }
  await prisma.emailOtpChallenge.updateMany({ where: { userId, purpose, consumedAt: null, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "superseded" } });

  const token = randomBytes(32).toString("hex");
  const challengeTokenHash = hashToken(token);
  const otp = generateOtp();
  const now = Date.now();
  const expiresAt = new Date(now + OTP_TTL_MS);
  const challenge = await prisma.emailOtpChallenge.create({
    data: { userId, challengeTokenHash, otpDigest: otpDigest(challengeTokenHash, otp), purpose, expiresAt, resendAvailableAt: new Date(now + OTP_RESEND_COOLDOWN_MS) },
  });
  await setCookie(purpose, token, expiresAt);
  const requestId = newRequestId();
  const auditSent = isDeletionPurpose(purpose) ? "account.deletion_otp_sent" : "account.restore_otp_sent";

  const sent = await sendActionOtpEmail(deliverTo, otp, EXPIRES_MINUTES, requestId, kind);
  if (!sent.ok) {
    await prisma.emailOtpChallenge.update({ where: { id: challenge.id }, data: { deliveryFailedAt: new Date() } });
    await recordAudit({ action: "auth.otp_delivery_failed", entityType: "EmailOtpChallenge", entityId: challenge.id, userId, metadata: { requestId, purpose, errorCode: sent.errorCode } });
    return { ok: false, created: true, error: "delivery" };
  }
  await recordAudit({ action: auditSent, entityType: "EmailOtpChallenge", entityId: challenge.id, userId, metadata: { requestId, maskedEmail: maskEmail(deliverTo) } });
  return { ok: true, created: true };
}

export type ActiveChallenge = { challenge: EmailOtpChallenge; user: User };

export async function getActionChallenge(purpose: ActionPurpose): Promise<ActiveChallenge | null> {
  const { name } = cookieFor(purpose);
  const store = await cookies();
  const token = store.get(name)?.value;
  if (!token) return null;
  const challenge = await prisma.emailOtpChallenge.findUnique({ where: { challengeTokenHash: hashToken(token) }, include: { user: true } });
  if (!challenge || challenge.purpose !== purpose) return null;
  if (challenge.consumedAt || challenge.revokedAt) return null;
  if (challenge.expiresAt.getTime() < Date.now()) return null;
  const { user, ...rest } = challenge;
  return { challenge: rest as EmailOtpChallenge, user };
}

export type VerifyResult = { ok: boolean; error?: string; locked?: boolean; expired?: boolean; challenge?: EmailOtpChallenge; user?: User };

/**
 * Verify a submitted code and CONSUME the challenge (replay-safe conditional
 * update) WITHOUT creating a session. On ok the caller performs the action. Two
 * concurrent successful submissions consume once — the second gets ok:false.
 */
export async function verifyActionChallenge(purpose: ActionPurpose, code: string): Promise<VerifyResult> {
  const current = await getActionChallenge(purpose);
  if (!current) { await clearActionCookie(purpose); return { ok: false, expired: true }; }
  const { challenge, user } = current;
  const failAudit = isDeletionPurpose(purpose) ? "account.deletion_otp_failed" : "account.restore_failed";

  if (challenge.attemptCount >= challenge.maxAttempts) {
    await prisma.emailOtpChallenge.updateMany({ where: { id: challenge.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "max_attempts" } });
    await clearActionCookie(purpose);
    return { ok: false, locked: true };
  }
  if (!verifyOtp(challenge.challengeTokenHash, code, challenge.otpDigest)) {
    const updated = await prisma.emailOtpChallenge.update({ where: { id: challenge.id }, data: { attemptCount: { increment: 1 } }, select: { attemptCount: true, maxAttempts: true } });
    if (updated.attemptCount >= updated.maxAttempts) {
      await prisma.emailOtpChallenge.updateMany({ where: { id: challenge.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "max_attempts" } });
      await clearActionCookie(purpose);
      return { ok: false, locked: true };
    }
    await recordAudit({ action: failAudit, entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id, metadata: { attempt: updated.attemptCount } });
    return { ok: false, error: "invalid" };
  }
  // Replay-safe consume — only the first winner proceeds.
  const consumed = await prisma.emailOtpChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, revokedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count === 0) return { ok: false, error: "invalid" };
  return { ok: true, challenge, user };
}

export async function revokeActionChallenges(userId: string, purpose: ActionPurpose, reason: string, db: Db = prisma): Promise<number> {
  const res = await db.emailOtpChallenge.updateMany({ where: { userId, purpose, consumedAt: null, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  return res.count;
}
