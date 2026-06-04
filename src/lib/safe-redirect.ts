// Validates a user-supplied "next" redirect target to prevent open redirects.
// Only same-site absolute paths are allowed: must start with a single "/", not
// be protocol-relative ("//"), and contain no backslashes or control chars
// (which browsers can normalize into an external URL).
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//")) return fallback;
  if (next.includes("\\")) return fallback;
  if (hasControlChar(next)) return fallback;
  return next;
}
