// OFD integration configuration. Reads ONLY from env; never exposes the secret.
// The whole feature is OFF by default. Saving connection secrets additionally
// requires OFD_SECRET (see crypto.ts) so ciphertext is never keyed off a missing
// secret in production.

export function ofdEnabled(): boolean {
  return process.env.OFD_INTEGRATIONS_ENABLED === "true";
}

/** OFD_SECRET present + long enough to key AES (never returns the value). */
export function ofdSecretPresent(): boolean {
  const s = process.env.OFD_SECRET;
  return Boolean(s && s.length >= 32);
}

/** Enabled AND able to encrypt secrets. In dev/test the secret has a safe
 * fallback, so this is true whenever the feature is enabled; in production it
 * additionally requires OFD_SECRET. */
export function ofdConfigured(): boolean {
  if (!ofdEnabled()) return false;
  if (process.env.NODE_ENV === "production") return ofdSecretPresent();
  return true;
}

/** Safe, value-free status for /api/health. */
export function ofdHealth(): { enabled: boolean; configured: boolean } {
  return { enabled: ofdEnabled(), configured: ofdConfigured() };
}

/**
 * Saby ОФД (СБИС) is behind its own feature flag (OFF by default) — a pilot provider gated
 * to owner/system admin until reconciled against a real cabinet. Requires the OFD feature on
 * too. UI/actions must check this before exposing Saby.
 */
export function ofdSabyEnabled(): boolean {
  return ofdEnabled() && process.env.OFD_SABY_ENABLED === "true";
}

export const OFD_SUPPORTED_PROVIDERS = ["taxcom"] as const;
export type OfdProvider = (typeof OFD_SUPPORTED_PROVIDERS)[number];
