/** @type {import('next').NextConfig} */

const isProd = process.env.NODE_ENV === "production";

// Conservative, app-compatible Content-Security-Policy. Allows: same-origin
// assets/API (documents, file downloads), Tailwind/Next inline styles, Next's
// inline bootstrap scripts, and image previews via data:/blob: URLs. Dev adds
// 'unsafe-eval' + ws: for React Fast Refresh / HMR (prod stays stricter).
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'self'",
  "object-src 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  `connect-src 'self'${isProd ? "" : " ws: wss:"}`,
  "worker-src 'self' blob:",
  "media-src 'self'",
  "manifest-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: csp },
];

const nextConfig = {
  reactStrictMode: true,
  // Keep the AWS SDK (used only by the S3 storage provider, server-side) out of
  // the bundle — it is required at runtime only when STORAGE_PROVIDER=s3.
  serverExternalPackages: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
