import { timingSafeEqual } from "node:crypto";

// Constant-time comparison for internal shared secrets (CRON / drain / Telegram
// webhook Bearer/header secrets). Fail-closed: a missing/empty server secret can
// never match. Handles differing lengths without an early length-based branch that
// would leak timing. Never logs the secret and returns only a boolean.
export function secretEquals(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (typeof expected !== "string" || expected.length === 0) return false; // no server secret → fail closed
  const a = Buffer.from(typeof provided === "string" ? provided : "", "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Do an equal-length compare against a constant to keep timing ~uniform, then fail.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Compares an `Authorization: Bearer <secret>` header against the expected secret,
 * constant-time. Missing header or server secret → false. */
export function bearerEquals(authorizationHeader: string | null | undefined, expected: string | null | undefined): boolean {
  if (typeof expected !== "string" || expected.length === 0) return false;
  const prefix = "Bearer ";
  const header = typeof authorizationHeader === "string" ? authorizationHeader : "";
  if (!header.startsWith(prefix)) {
    secretEquals("", expected); // keep timing shape, then fail
    return false;
  }
  return secretEquals(header.slice(prefix.length), expected);
}
