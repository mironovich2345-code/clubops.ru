import { createHmac } from "node:crypto";
import { resolveSecret } from "@/lib/env-secrets";

// Keyed hashing for opaque tokens (session + invite). Only the HMAC of a token
// is ever stored; a leaked hash cannot be turned back into a usable cookie
// without SESSION_SECRET. Extracted into its own module so the session service
// and auth layer can share it without an import cycle. Resolved lazily so a
// missing/weak secret fails fast on first use in production, not during `next
// build`. Production requires SESSION_SECRET to be present AND >= 32 chars.
export const SESSION_SECRET_MIN_LENGTH = 32;
function sessionSecret(): string {
  return resolveSecret("SESSION_SECRET", {
    minLength: SESSION_SECRET_MIN_LENGTH,
    devFallback: "dev-insecure-session-secret-not-for-production-use-only",
  });
}

export function hashToken(token: string): string {
  return createHmac("sha256", sessionSecret()).update(token).digest("hex");
}
