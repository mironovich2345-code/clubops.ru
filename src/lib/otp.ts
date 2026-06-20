import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

// Email OTP crypto + policy. The plaintext code is NEVER stored or logged; only
// an HMAC digest keyed by OTP_SECRET is persisted. A 6-digit code has low
// entropy, so the digest is salted by the per-challenge token hash and the key
// is a dedicated secret (not SESSION_SECRET / SMTP password / DB password).

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
export const OTP_MAX_SENDS_PER_HOUR = 5;

function otpSecret(): string {
  const secret = process.env.OTP_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("OTP_SECRET is required in production");
  }
  return "dev-insecure-otp-secret";
}

/** Cryptographically secure numeric OTP (leading zeroes preserved). */
export function generateOtp(): string {
  let out = "";
  for (let i = 0; i < OTP_LENGTH; i++) out += String(randomInt(0, 10));
  return out;
}

/**
 * Salted, keyed digest of an OTP. Salting by the per-challenge token hash means
 * the same code under two challenges yields different digests, defeating
 * precomputation against the low-entropy code space.
 */
export function otpDigest(challengeTokenHash: string, otp: string): string {
  return createHmac("sha256", otpSecret())
    .update(`${challengeTokenHash}:${otp}`)
    .digest("hex");
}

/** Constant-time comparison of a candidate OTP against a stored digest. */
export function verifyOtp(challengeTokenHash: string, candidate: string, storedDigest: string): boolean {
  if (!/^\d{6}$/.test(candidate)) return false;
  const a = Buffer.from(otpDigest(challengeTokenHash, candidate), "utf8");
  const b = Buffer.from(storedDigest, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Mask an email for display: "m***@company.ru". */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}
