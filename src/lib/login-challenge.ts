// Login OTP challenge service (server-only). The single place that creates,
// resends, verifies and revokes email-OTP login challenges. A real Session is
// created ONLY here, after a verified challenge. The temporary cookie holds only
// an opaque random token; its HMAC is stored. The OTP is never stored/logged in
// plaintext (see lib/otp).
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import type { EmailOtpChallenge, Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/tokens";
import { recordAudit } from "@/lib/access";
import { createSession } from "@/lib/session";
import { completeLoginAttach } from "@/lib/account-container";
import { sendOtpEmail } from "@/lib/email";
import { applyPendingInvitesForUser } from "@/lib/invite-service";
import {
  generateOtp,
  otpDigest,
  verifyOtp,
  maskEmail,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_MAX_SENDS_PER_HOUR,
} from "@/lib/otp";

type Db = typeof prisma | Prisma.TransactionClient;

export const CHALLENGE_COOKIE = "club_ops_login_challenge";
const CHALLENGE_COOKIE_PATH = "/login";
const EXPIRES_MINUTES = Math.round(OTP_TTL_MS / 60000);

function newRequestId(): string {
  return randomBytes(8).toString("hex");
}

async function setChallengeCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: CHALLENGE_COOKIE_PATH,
    expires: expiresAt,
  });
}

export async function clearChallengeCookie(): Promise<void> {
  const store = await cookies();
  store.set(CHALLENGE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: CHALLENGE_COOKIE_PATH,
    expires: new Date(0),
  });
}

/** Total OTP sends for a user in the rolling last hour (across challenges). */
async function sendsInLastHour(userId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await prisma.emailOtpChallenge.findMany({
    where: { userId, lastSentAt: { gte: since } },
    select: { sendCount: true },
  });
  return rows.reduce((sum, r) => sum + r.sendCount, 0);
}

export type StartResult = { ok: boolean; created: boolean; error?: string };

/**
 * Begin a login OTP challenge for an ALREADY-AUTHENTICATED-BY-PASSWORD user.
 * Revokes prior unconsumed challenges, creates a fresh one, emails the code and
 * sets the temporary cookie. Returns created=true when a challenge row exists
 * (so the caller can route to the verify page even if delivery failed).
 */
export async function startLoginChallenge(user: { id: string; email: string; isActive: boolean }): Promise<StartResult> {
  if (!user.isActive) return { ok: false, created: false, error: "inactive" };

  // Hourly send ceiling (counts the existing window before this new send).
  if ((await sendsInLastHour(user.id)) >= OTP_MAX_SENDS_PER_HOUR) {
    await recordAudit({
      action: "auth.otp_resend_blocked", entityType: "User", entityId: user.id, userId: user.id,
      metadata: { reason: "hourly_limit", maskedEmail: maskEmail(user.email) },
    });
    return { ok: false, created: false, error: "rate" };
  }

  // Only one usable login challenge per user — supersede the rest.
  await prisma.emailOtpChallenge.updateMany({
    where: { userId: user.id, purpose: "login", consumedAt: null, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "superseded" },
  });

  const token = randomBytes(32).toString("hex");
  const challengeTokenHash = hashToken(token);
  const otp = generateOtp();
  const now = Date.now();
  const expiresAt = new Date(now + OTP_TTL_MS);

  const challenge = await prisma.emailOtpChallenge.create({
    data: {
      userId: user.id,
      challengeTokenHash,
      otpDigest: otpDigest(challengeTokenHash, otp),
      purpose: "login",
      expiresAt,
      resendAvailableAt: new Date(now + OTP_RESEND_COOLDOWN_MS),
    },
  });
  await setChallengeCookie(token, expiresAt);
  const requestId = newRequestId();
  await recordAudit({
    action: "auth.otp_challenge_created", entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id,
    metadata: { requestId, purpose: "login", maskedEmail: maskEmail(user.email) },
  });

  const sent = await sendOtpEmail(user.email, otp, EXPIRES_MINUTES, requestId);
  if (!sent.ok) {
    await prisma.emailOtpChallenge.update({ where: { id: challenge.id }, data: { deliveryFailedAt: new Date() } });
    await recordAudit({
      action: "auth.otp_delivery_failed", entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id,
      metadata: { requestId, errorCode: sent.errorCode },
    });
    return { ok: false, created: true, error: "delivery" };
  }
  await recordAudit({
    action: "auth.otp_sent", entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id,
    metadata: { requestId, sendCount: 1 },
  });
  return { ok: true, created: true };
}

type ActiveChallenge = { challenge: EmailOtpChallenge; user: User };

/** Resolve + validate the current request's login challenge from the cookie. */
export async function getCurrentChallenge(): Promise<ActiveChallenge | null> {
  const store = await cookies();
  const token = store.get(CHALLENGE_COOKIE)?.value;
  if (!token) return null;
  const challenge = await prisma.emailOtpChallenge.findUnique({
    where: { challengeTokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!challenge) return null;
  if (challenge.consumedAt || challenge.revokedAt) return null;
  if (challenge.expiresAt.getTime() < Date.now()) return null;
  if (!challenge.user || !challenge.user.isActive) return null;
  const { user, ...rest } = challenge;
  return { challenge: rest as EmailOtpChallenge, user };
}

export type ResendResult = { ok: boolean; error?: string; expired?: boolean };

/** Resend a new code for the current challenge (server-enforced limits). */
export async function resendCurrentChallenge(): Promise<ResendResult> {
  const current = await getCurrentChallenge();
  if (!current) return { ok: false, expired: true };
  const { challenge, user } = current;

  if (Date.now() < challenge.resendAvailableAt.getTime()) {
    await recordAudit({ action: "auth.otp_resend_blocked", entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id, metadata: { reason: "cooldown" } });
    return { ok: false, error: "cooldown" };
  }
  if ((await sendsInLastHour(user.id)) >= OTP_MAX_SENDS_PER_HOUR) {
    await recordAudit({ action: "auth.otp_resend_blocked", entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id, metadata: { reason: "hourly_limit" } });
    return { ok: false, error: "rate" };
  }

  const otp = generateOtp();
  const now = Date.now();
  const expiresAt = new Date(now + OTP_TTL_MS);
  // Replacing the digest atomically invalidates the previously sent code; only
  // the latest persisted code can verify.
  await prisma.emailOtpChallenge.update({
    where: { id: challenge.id },
    data: {
      otpDigest: otpDigest(challenge.challengeTokenHash, otp),
      expiresAt,
      resendAvailableAt: new Date(now + OTP_RESEND_COOLDOWN_MS),
      lastSentAt: new Date(),
      sendCount: { increment: 1 },
    },
  });
  // Bump the cookie expiry to match, re-using the SAME opaque token.
  const store = await cookies();
  const existingToken = store.get(CHALLENGE_COOKIE)?.value;
  if (existingToken) await setChallengeCookie(existingToken, expiresAt);

  const requestId = newRequestId();
  const sent = await sendOtpEmail(user.email, otp, EXPIRES_MINUTES, requestId);
  if (!sent.ok) {
    await prisma.emailOtpChallenge.update({ where: { id: challenge.id }, data: { deliveryFailedAt: new Date() } });
    await recordAudit({ action: "auth.otp_delivery_failed", entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id, metadata: { requestId, errorCode: sent.errorCode } });
    return { ok: false, error: "delivery" };
  }
  await recordAudit({ action: "auth.otp_resent", entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id, metadata: { requestId, sendCount: challenge.sendCount + 1 } });
  return { ok: true };
}

export type VerifyResult = { ok: boolean; error?: string; locked?: boolean; expired?: boolean };

/**
 * Verify a submitted code against the current challenge and, on success, create
 * the real Session. Replay-safe: the challenge is consumed with a conditional
 * update, so two concurrent successful submissions create at most one Session.
 */
export async function verifyCurrentChallenge(code: string): Promise<VerifyResult> {
  const current = await getCurrentChallenge();
  if (!current) {
    await clearChallengeCookie();
    return { ok: false, expired: true };
  }
  const { challenge, user } = current;

  if (challenge.attemptCount >= challenge.maxAttempts) {
    await prisma.emailOtpChallenge.updateMany({ where: { id: challenge.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "max_attempts" } });
    await clearChallengeCookie();
    await recordAudit({ action: "auth.otp_locked", entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id });
    return { ok: false, locked: true };
  }

  if (!verifyOtp(challenge.challengeTokenHash, code, challenge.otpDigest)) {
    const updated = await prisma.emailOtpChallenge.update({
      where: { id: challenge.id },
      data: { attemptCount: { increment: 1 } },
      select: { attemptCount: true, maxAttempts: true },
    });
    if (updated.attemptCount >= updated.maxAttempts) {
      await prisma.emailOtpChallenge.updateMany({ where: { id: challenge.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "max_attempts" } });
      await clearChallengeCookie();
      await recordAudit({ action: "auth.otp_locked", entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id, metadata: { attempt: updated.attemptCount } });
      return { ok: false, locked: true };
    }
    await recordAudit({ action: "auth.otp_failed", entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id, metadata: { attempt: updated.attemptCount } });
    return { ok: false, error: "invalid" };
  }

  // Replay-safe consume: only the first concurrent winner flips consumedAt.
  const consumed = await prisma.emailOtpChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, revokedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    return { ok: false, error: "invalid" }; // already consumed elsewhere
  }

  const emailWasUnverified = user.emailVerifiedAt === null;
  if (emailWasUnverified) {
    await prisma.user.updateMany({ where: { id: user.id, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
    await recordAudit({ action: "user.email_verified", entityType: "User", entityId: user.id, userId: user.id, metadata: { maskedEmail: maskEmail(user.email) } });
    // Auto-apply any active pending invites for this now-verified email so the
    // user lands with access already granted (no manual "Accept" step). Never
    // blocks login — a failure here is logged and swallowed.
    try {
      await applyPendingInvitesForUser({ id: user.id, email: user.email });
    } catch (err) {
      console.error("auto-apply invites failed", { userId: user.id, code: (err as { code?: string })?.code });
    }
  }
  // Supersede any other live challenges for this user.
  await prisma.emailOtpChallenge.updateMany({
    where: { userId: user.id, id: { not: challenge.id }, consumedAt: null, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "superseded" },
  });

  await recordAudit({ action: "auth.otp_verified", entityType: "EmailOtpChallenge", entityId: challenge.id, userId: user.id });

  // Only now is a real Session created (sets the session cookie + UA metadata).
  const sessionId = await createSession(user.id);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await recordAudit({ action: "session.created", entityType: "Session", entityId: sessionId, userId: user.id, metadata: { via: "otp" } });

  // Multi-account: attach the new session to this device's container. With an
  // add-account intent this ADDS an account (keeping the others); otherwise it only
  // updates an existing container (re-login) — a single-account device stays as-is.
  try {
    const { added } = await completeLoginAttach(sessionId, user.id);
    if (added) {
      await recordAudit({ action: "account.added_to_device", entityType: "Session", entityId: sessionId, userId: user.id });
    }
  } catch (err) {
    console.error("multi-account attach failed", { userId: user.id, code: (err as { code?: string })?.code });
  }

  await clearChallengeCookie();
  return { ok: true };
}

/** Revoke all active login challenges for a user (admin email-change / 2FA reset). */
export async function revokeChallengesForUser(userId: string, reason: string, db: Db = prisma): Promise<number> {
  const res = await db.emailOtpChallenge.updateMany({
    where: { userId, consumedAt: null, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return res.count;
}

/** The masked email for the current challenge (verify-page display). */
export async function getChallengeMaskedEmail(): Promise<string | null> {
  const current = await getCurrentChallenge();
  return current ? maskEmail(current.user.email) : null;
}

/** Retention cleanup for consumed/revoked/expired challenges (Part 19). */
export async function cleanupStaleChallenges(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const res = await prisma.emailOtpChallenge.deleteMany({
    where: {
      OR: [
        { consumedAt: { not: null, lt: cutoff } },
        { revokedAt: { not: null, lt: cutoff } },
        { expiresAt: { lt: cutoff } },
      ],
    },
  });
  return res.count;
}
