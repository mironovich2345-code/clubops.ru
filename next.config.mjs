/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep the AWS SDK (used only by the S3 storage provider, server-side) out of
  // the bundle — it is required at runtime only when STORAGE_PROVIDER=s3.
  serverExternalPackages: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"],
};

export default nextConfig;
