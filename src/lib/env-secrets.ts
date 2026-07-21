// Server-only helper for resolving HMAC/crypto secrets from the environment with a
// single, consistent fail-closed policy. NEVER logs or returns the secret VALUE in
// an error — only the variable name and the length requirement.
//
// Production: the secret MUST be present AND at least `minLength` characters, else
// the process fails closed (throws) on first use. Non-production: a real secret is
// used if set (any length); otherwise a clearly-insecure dev fallback is returned
// with a one-time warning. Dev fallbacks must NEVER resemble a production value.

const warnedFor = new Set<string>();

function warnDevFallbackOnce(name: string): void {
  if (warnedFor.has(name)) return;
  warnedFor.add(name);
  // Non-production only (this branch is never reached in production).
  console.warn(`[env-secrets] ${name} is not set — using an INSECURE dev fallback. Do NOT use in production.`);
}

export function resolveSecret(name: string, opts: { minLength: number; devFallback: string }): string {
  const value = process.env[name];
  const isProd = process.env.NODE_ENV === "production";

  if (value && value.length > 0) {
    if (isProd && value.length < opts.minLength) {
      throw new Error(`${name} must be at least ${opts.minLength} characters in production`);
    }
    return value;
  }

  if (isProd) {
    throw new Error(`${name} is required in production`);
  }
  warnDevFallbackOnce(name);
  return opts.devFallback;
}

/** True when a secret satisfies the production policy (present + long enough).
 * Pure — used by health/diagnostics and tests; never reveals the value. */
export function secretMeetsPolicy(value: string | null | undefined, minLength: number): boolean {
  return typeof value === "string" && value.length >= minLength;
}
