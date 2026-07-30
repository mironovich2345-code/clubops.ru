import { NextResponse, type NextRequest } from "next/server";

// Per-request Content-Security-Policy with a nonce, so 'unsafe-inline' can be
// dropped from script-src. Inline scripts (Next's RSC/hydration bootstrap + our
// theme-init script) run only with the request nonce; same-origin script FILES are
// allowed by 'self'. Next 15 auto-propagates the nonce (read from the CSP request
// header) to its own inline scripts; our theme script reads it from `x-nonce`.
// Also adds Permissions-Policy. Other static headers stay in next.config.mjs.

const isProd = process.env.NODE_ENV === "production";

// Document-serving API routes are meant to be embedded in the in-app viewer's
// same-origin <iframe> (PDF preview). They must allow SAME-ORIGIN framing; every other
// route stays un-framable. Matches /api/<entity>/<id>/file and
// /api/<entity>/<id>/documents/<docId>.
const DOC_EMBED_ROUTE = /^\/api\/[^/]+\/[^/]+\/(file|documents)(\/|$)/;
function isDocEmbedPath(pathname: string): boolean {
  return DOC_EMBED_ROUTE.test(pathname);
}

function buildCsp(nonce: string, frameable: boolean): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    // Who may frame THIS response: pages/none; document responses allow our own origin.
    frameable ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    "frame-src 'self'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Styles: Tailwind/Next inject inline styles; a style nonce is impractical and
    // style injection cannot execute script, so 'unsafe-inline' is kept for styles only.
    "style-src 'self' 'unsafe-inline'",
    // Scripts: nonce for inline (bootstrap + theme), 'self' for same-origin chunks.
    // Dev adds 'unsafe-eval' for React Fast Refresh; prod stays strict.
    `script-src 'self' 'nonce-${nonce}'${isProd ? "" : " 'unsafe-eval'"}`,
    `connect-src 'self'${isProd ? "" : " ws: wss:"}`,
    "worker-src 'self' blob:",
    "media-src 'self'",
    "manifest-src 'self'",
  ].join("; ");
}

const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()";

export function middleware(request: NextRequest): NextResponse {
  // 128-bit nonce (base64). Web Crypto is available on the Edge runtime.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const nonce = btoa(binary);
  // Same-origin document embeds (viewer <iframe>) may be framed by our own origin;
  // everything else is DENY / frame-ancestors 'none' (clickjacking protection).
  const frameable = isDocEmbedPath(request.nextUrl.pathname);
  const csp = buildCsp(nonce, frameable);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next reads the nonce from this request header and applies it to its scripts.
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("permissions-policy", PERMISSIONS_POLICY);
  response.headers.set("x-frame-options", frameable ? "SAMEORIGIN" : "DENY");
  return response;
}

export const config = {
  // Apply to all routes EXCEPT Next static assets / image optimizer / favicon.
  // File downloads and API routes still receive the headers.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
