/** @type {import('next').NextConfig} */

// The Content-Security-Policy is now set PER REQUEST with a nonce in
// src/middleware.ts (so 'unsafe-inline' is dropped from script-src) — it must NOT
// also be set here or the two would conflict. Clickjacking protection (X-Frame-Options
// + CSP frame-ancestors) is ALSO set per-request in the middleware, because the
// document-serving API routes must allow SAME-ORIGIN framing (the in-app viewer embeds
// a PDF in an <iframe>) while every page stays DENY. A blanket DENY here would win over
// any per-route override and break the viewer, so it is intentionally NOT set here.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig = {
  reactStrictMode: true,
  // Do not advertise the framework (X-Powered-By).
  poweredByHeader: false,
  // Standalone server output: `.next/standalone/server.js` bundles only the
  // traced runtime deps, so the production Docker image stays small and does not
  // need the full node_modules or `next start`. Backward-compatible — `next
  // start` still works locally / in the existing single-container flow.
  output: "standalone",
  // Keep the AWS SDK (used only by the S3 storage provider, server-side) out of
  // the bundle — it is required at runtime only when STORAGE_PROVIDER=s3.
  serverExternalPackages: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "unpdf"],
  // Server Actions body limit. The default (~1 MB) is BELOW the 10 MB per-file upload
  // cap, so a 1–10 MB document was rejected by Next BEFORE the handler ran — surfacing
  // as a thrown transport error and the generic "Ошибка загрузки". Raise it above the
  // single-file cap (+ multipart overhead). The reverse proxy stays the outer gate.
  experimental: {
    serverActions: { bodySizeLimit: "20mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
