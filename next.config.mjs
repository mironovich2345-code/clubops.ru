/** @type {import('next').NextConfig} */

// The Content-Security-Policy is now set PER REQUEST with a nonce in
// src/middleware.ts (so 'unsafe-inline' is dropped from script-src) — it must NOT
// also be set here or the two would conflict. These are the static headers that
// don't need a nonce; Permissions-Policy is added by the middleware, HSTS by Caddy.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
