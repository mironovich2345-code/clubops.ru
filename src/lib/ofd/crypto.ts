// Server-only encryption for OFD connection secrets (login / password /
// integration token / integrator id). AES-256-GCM keyed by OFD_SECRET (a secret
// DISTINCT from SESSION_SECRET / ACCOUNT_RECOVERY_SECRET). Ciphertext is stored
// as "v1:base64(iv[12]|tag[16]|ciphertext)" — the plaintext secret is NEVER
// persisted and NEVER logged.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function ofdSecret(): string {
  const s = process.env.OFD_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("OFD_SECRET (>=32 chars) is required to store OFD connection secrets");
  }
  return "dev-insecure-ofd-secret-at-least-32-bytes";
}

/** 32-byte AES key derived from OFD_SECRET (SHA-256, domain-separated). */
function aesKey(): Buffer {
  return createHash("sha256").update(`ofd:aes:${ofdSecret()}`).digest();
}

const VERSION = "v1";

/** Encrypt a secret → "v1:base64(iv|tag|ciphertext)". Authenticated (GCM). */
export function encryptOfdSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

/** Decrypt a payload produced by encryptOfdSecret. Returns null on any failure. */
export function decryptOfdSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const idx = payload.indexOf(":");
  if (idx < 0 || payload.slice(0, idx) !== VERSION) return null;
  try {
    const buf = Buffer.from(payload.slice(idx + 1), "base64");
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

/** True when a value looks like our versioned ciphertext (not plaintext). */
export function isEncryptedSecret(payload: string | null | undefined): boolean {
  return typeof payload === "string" && payload.startsWith(`${VERSION}:`);
}
