import { headers } from "next/headers";

// Best-effort client IP for rate limiting. Caddy (the only public ingress) sets
// X-Forwarded-For; the FIRST entry is the real client. The value is only ever fed
// to the rate limiter as a HASHED bucket identifier — the raw IP is never stored or
// logged. Falls back to a constant so a missing header still buckets requests.
export async function getClientIp(): Promise<string> {
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = h.get("x-real-ip");
  return real?.trim() || "unknown";
}
