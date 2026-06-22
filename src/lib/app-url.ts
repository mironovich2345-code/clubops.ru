// Centralized resolution of the application's public base URL. Used wherever an
// ABSOLUTE URL is required (invitation links, email links, canonical/OG
// metadata). Internal navigation stays relative.
//
// Source of truth: process.env.APP_URL (e.g. https://pilot.clubops.ru).
//   - validated as a real URL, trailing slash removed;
//   - HTTPS required in production; http allowed only outside production;
//   - never derived from Host / X-Forwarded-* headers (avoids host-header
//     spoofing of security-sensitive absolute URLs);
//   - never silently falls back to the Railway hostname.
// The Railway-generated domain remains a working technical fallback for serving
// the app, but is never used to mint absolute links.

const DEV_DEFAULT = "http://localhost:3000";

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * The validated public base URL with no trailing slash.
 * Throws a sanitized configuration error when an absolute URL is REQUIRED but
 * APP_URL is missing/invalid in production. Outside production it falls back to
 * http://localhost:3000 for developer convenience.
 */
export function getAppUrl(): string {
  const raw = process.env.APP_URL?.trim();
  const isProd = process.env.NODE_ENV === "production";

  if (raw) {
    const u = parse(raw);
    if (u && (u.protocol === "https:" || (!isProd && u.protocol === "http:"))) {
      return stripTrailingSlash(raw);
    }
  }

  if (isProd) {
    // Sanitized — never leaks the offending value.
    throw new Error("APP_URL is not configured with a valid https:// URL");
  }
  return DEV_DEFAULT;
}

/**
 * Non-throwing variant for NON-security-critical uses (metadataBase, optional
 * absolute-link display). Returns null instead of throwing when APP_URL is
 * misconfigured, so a missing variable never crashes page rendering or a build.
 */
export function getAppUrlSafe(): string | null {
  try {
    return getAppUrl();
  } catch {
    return null;
  }
}

/** Build an absolute URL from an internal path using the configured base. */
export function absoluteUrl(path: string): string {
  const base = getAppUrl();
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Non-throwing absolute-URL builder (null when APP_URL is misconfigured). */
export function absoluteUrlSafe(path: string): string | null {
  const base = getAppUrlSafe();
  if (!base) return null;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}
