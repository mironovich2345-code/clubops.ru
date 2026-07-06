// Cryptography for account deletion / recovery (server-only). Uses a DEDICATED
// secret ACCOUNT_RECOVERY_SECRET (distinct from SESSION_SECRET / OTP_SECRET /
// SMTP / DB). Provides:
//   - AES-256-GCM authenticated encryption of the original email;
//   - keyed HMAC for email lookup and recovery-token lookup (no plaintext token
//     ever stored).
// Fail-safe: the secret is resolved lazily and only these deletion/recovery
// operations require it — unrelated pages never import this module, so a missing
// secret cannot crash the app; it fails only the deletion/recovery action.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function recoverySecret(): string {
  const secret = process.env.ACCOUNT_RECOVERY_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("ACCOUNT_RECOVERY_SECRET (>=32 chars) is required for account deletion/recovery");
  }
  return "dev-insecure-account-recovery-secret-32b";
}

// 32-byte AES key derived from the secret (SHA-256). The HMAC helpers key
// directly off the secret with a domain-separation label.
function aesKey(): Buffer {
  return createHash("sha256").update(`aes:${recoverySecret()}`).digest();
}

function hmac(label: string, value: string): string {
  return createHmac("sha256", recoverySecret()).update(`${label}:${value}`).digest("hex");
}

/** True when ACCOUNT_RECOVERY_SECRET is configured well enough to operate. */
export function recoveryConfigured(): boolean {
  const s = process.env.ACCOUNT_RECOVERY_SECRET;
  return process.env.NODE_ENV !== "production" || Boolean(s && s.length >= 32);
}

// --- Email encryption (AES-256-GCM) ---------------------------------------

/** Encrypt an email → base64(iv[12] | tag[16] | ciphertext). Authenticated. */
export function encryptEmail(email: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(), iv);
  const ct = Buffer.concat([cipher.update(email, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt a payload produced by encryptEmail. Returns null on any failure. */
export function decryptEmail(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    const buf = Buffer.from(payload, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", aesKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// --- Lookup hashes ---------------------------------------------------------

/** HMAC of a NORMALIZED email, for finding a deletion record without decrypting. */
export function emailLookupHash(normalizedEmail: string): string {
  return hmac("email", normalizedEmail);
}

/** A fresh random recovery token (raw) + its stored HMAC. Raw goes in the link. */
export function generateRecoveryToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hmac("recovery", token) };
}

export function hashRecoveryToken(token: string): string {
  return hmac("recovery", token);
}

/** Constant-time compare of two hex digests (defensive). */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
