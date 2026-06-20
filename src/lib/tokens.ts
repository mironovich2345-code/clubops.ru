import { createHmac } from "node:crypto";

// Keyed hashing for opaque tokens (session + invite). Only the HMAC of a token
// is ever stored; a leaked hash cannot be turned back into a usable cookie
// without SESSION_SECRET. Extracted into its own module so the session service
// and auth layer can share it without an import cycle. Resolved lazily so a
// missing secret fails fast on first use in production, not during `next build`.
function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production");
  }
  return "dev-insecure-session-secret";
}

export function hashToken(token: string): string {
  return createHmac("sha256", sessionSecret()).update(token).digest("hex");
}
