// DB-backed fixed-window rate limiting for abusable / expensive surfaces. Works
// across multiple app instances and survives restarts (unlike an in-memory Map).
//
// Privacy: only NON-reversible HMAC hashes of the identifier (IP / email / userId)
// are stored — never the raw value. The window index is folded into the bucketKey,
// so a single atomic upsert-increment per window is race-safe (the unique bucketKey
// serialises concurrent hits; both increments count).
//
// Errors NEVER reveal the raw identifier, the counter, or a DB id — callers surface
// a generic "too many attempts" message. Rows are short-lived and pruned by expiry.
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { resolveSecret } from "@/lib/env-secrets";

export type RateLimitAction =
  | "login"
  | "register"
  | "otp_send"
  | "otp_resend"
  | "ai_analyze"
  | "ai_analyze_company"
  | "ofd_sync_now"
  | "telegram_link"
  | "settings_pin";

export type IdentifierType = "ip" | "email" | "user" | "company";

export type RateLimitRule = { limit: number; windowMs: number };

// Conservative defaults (see §8.3). Values are here so they can be tuned centrally.
const MIN = 60_000;
const HOUR = 60 * MIN;
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  "login:email": { limit: 10, windowMs: 15 * MIN },
  "login:ip": { limit: 30, windowMs: 15 * MIN },
  "register:ip": { limit: 5, windowMs: HOUR },
  "otp_send:user": { limit: 5, windowMs: HOUR },
  "otp_resend:user": { limit: 5, windowMs: HOUR },
  "ai_analyze:user": { limit: 20, windowMs: HOUR },
  "ai_analyze_company:company": { limit: 100, windowMs: HOUR },
  "ofd_sync_now:company": { limit: 1, windowMs: 5 * MIN },
  "telegram_link:user": { limit: 5, windowMs: HOUR },
  "settings_pin:user": { limit: 10, windowMs: 15 * MIN },
  "settings_pin:company": { limit: 30, windowMs: HOUR },
};

export function ruleFor(action: RateLimitAction, idType: IdentifierType): RateLimitRule | null {
  return RATE_LIMITS[`${action}:${idType}`] ?? null;
}

// HMAC (keyed by SESSION_SECRET) of the identifier — never store the raw IP/email.
function hashIdentifier(idType: IdentifierType, identifier: string): string {
  const key = resolveSecret("SESSION_SECRET", { minLength: 32, devFallback: "dev-insecure-session-secret-not-for-production-use-only" });
  return createHmac("sha256", key).update(`ratelimit:${idType}:${identifier}`).digest("hex");
}

function bucketKeyFor(action: string, idType: string, idHash: string, windowIndex: number): string {
  return createHmac("sha256", "ratelimit-bucket").update(`${action}|${idType}|${idHash}|${windowIndex}`).digest("hex");
}

export type RateLimitResult = { allowed: boolean; count: number; limit: number; retryAfterSeconds: number };

/**
 * Atomically records one hit for (action, idType, identifier) in the current fixed
 * window and reports whether the limit is now exceeded. `now` is injectable for
 * deterministic tests. Fail-OPEN on a DB error (availability > strictness for a
 * best-effort limiter) — the primary auth controls (OTP, CAS) still apply.
 */
export async function checkRateLimit(
  action: RateLimitAction,
  idType: IdentifierType,
  identifier: string,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const rule = ruleFor(action, idType);
  if (!rule) return { allowed: true, count: 0, limit: Infinity, retryAfterSeconds: 0 };

  const windowIndex = Math.floor(now / rule.windowMs);
  const windowStart = new Date(windowIndex * rule.windowMs);
  const expiresAt = new Date((windowIndex + 1) * rule.windowMs);
  const bucketKey = bucketKeyFor(action, idType, hashIdentifier(idType, identifier), windowIndex);

  let count: number;
  try {
    const row = await prisma.rateLimitBucket.upsert({
      where: { bucketKey },
      create: { bucketKey, action, windowStart, count: 1, expiresAt },
      update: { count: { increment: 1 } },
      select: { count: true },
    });
    count = row.count;
  } catch {
    // Fail open (best-effort) — do not block legitimate users on a limiter DB blip.
    return { allowed: true, count: 0, limit: rule.limit, retryAfterSeconds: 0 };
  }

  return {
    allowed: count <= rule.limit,
    count,
    limit: rule.limit,
    retryAfterSeconds: Math.max(0, Math.ceil((expiresAt.getTime() - now) / 1000)),
  };
}

/** Best-effort: only tell whether the limit is exceeded (no counter leak to callers). */
export async function isRateLimited(action: RateLimitAction, idType: IdentifierType, identifier: string, now?: number): Promise<boolean> {
  return !(await checkRateLimit(action, idType, identifier, now)).allowed;
}

/**
 * Reads the CURRENT window count WITHOUT incrementing — used to gate on the number
 * of prior FAILURES (e.g. the per-account login-failure cap) so a successful login
 * is not counted and never causes a false lock-out. `limited` = count >= limit.
 */
export async function peekRateLimit(action: RateLimitAction, idType: IdentifierType, identifier: string, now: number = Date.now()): Promise<{ count: number; limit: number; limited: boolean }> {
  const rule = ruleFor(action, idType);
  if (!rule) return { count: 0, limit: Infinity, limited: false };
  const windowIndex = Math.floor(now / rule.windowMs);
  const bucketKey = bucketKeyFor(action, idType, hashIdentifier(idType, identifier), windowIndex);
  try {
    const row = await prisma.rateLimitBucket.findUnique({ where: { bucketKey }, select: { count: true } });
    const count = row?.count ?? 0;
    return { count, limit: rule.limit, limited: count >= rule.limit };
  } catch {
    return { count: 0, limit: rule.limit, limited: false };
  }
}

/** Generic user-facing message — never reveals counters, IP, email or ids. */
export const RATE_LIMIT_MESSAGE = "Слишком много попыток. Повторите позже.";

/** Prune expired buckets. Called opportunistically and/or by a cleanup job. */
export async function pruneRateLimitBuckets(now: number = Date.now()): Promise<number> {
  try {
    const res = await prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
    return res.count;
  } catch {
    return 0;
  }
}
