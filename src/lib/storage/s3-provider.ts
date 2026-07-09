import { type StorageProvider, isSafeStorageKey } from "./types";

// S3-compatible provider for production. Works with any S3 API endpoint —
// designed for Russian object storage (Yandex Object Storage, Selectel, VK
// Cloud) as well as AWS. Credentials come only from the environment and are
// never returned to callers.
//
// The AWS SDK is imported dynamically so it is loaded only when STORAGE_PROVIDER
// is "s3"; local/dev never pulls it into the request path.

type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function readConfig(): S3Config {
  const endpoint = process.env.S3_ENDPOINT ?? "";
  const region = process.env.S3_REGION || "ru-central1";
  const bucket = process.env.S3_BUCKET ?? "";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "";
  const missing = [
    ["S3_ENDPOINT", endpoint],
    ["S3_BUCKET", bucket],
    ["S3_ACCESS_KEY_ID", accessKeyId],
    ["S3_SECRET_ACCESS_KEY", secretAccessKey],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`S3 storage is not configured: missing ${missing.join(", ")}`);
  }
  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

// Cache the client (and config) across requests within a server instance.
let clientPromise: Promise<{ client: unknown; bucket: string }> | null = null;

async function getClient(): Promise<{ client: unknown; bucket: string }> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const cfg = readConfig();
      const { S3Client } = await import("@aws-sdk/client-s3");
      const client = new S3Client({
        endpoint: cfg.endpoint,
        region: cfg.region,
        // Path-style addressing is the most compatible across RU providers.
        forcePathStyle: true,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      });
      return { client, bucket: cfg.bucket };
    })();
  }
  return clientPromise;
}

export function createS3StorageProvider(): StorageProvider {
  return {
    name: "s3",

    async put(key, buffer, mime) {
      if (!isSafeStorageKey(key)) throw new Error("Unsafe storage key");
      const { client, bucket } = await getClient();
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      await (client as { send: (c: unknown) => Promise<unknown> }).send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: mime }),
      );
    },

    async get(key) {
      if (!isSafeStorageKey(key)) return null;
      const { client, bucket } = await getClient();
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      try {
        const out = (await (client as { send: (c: unknown) => Promise<unknown> }).send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        )) as { Body?: { transformToByteArray?: () => Promise<Uint8Array> } };
        if (!out.Body?.transformToByteArray) return null;
        return Buffer.from(await out.Body.transformToByteArray());
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === "NoSuchKey" || name === "NotFound") return null;
        throw error;
      }
    },

    async exists(key) {
      if (!isSafeStorageKey(key)) return false;
      const { client, bucket } = await getClient();
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      try {
        await (client as { send: (c: unknown) => Promise<unknown> }).send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return true;
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === "NoSuchKey" || name === "NotFound") return false;
        throw error; // AccessDenied / config errors must NOT look like "missing".
      }
    },

    async getSignedUrl(key, opts) {
      if (!isSafeStorageKey(key)) return null;
      const { client, bucket } = await getClient();
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: opts?.downloadName
          ? `inline; filename="${opts.downloadName.replace(/["\r\n]/g, "")}"`
          : undefined,
      });
      return getSignedUrl(client as never, command as never, {
        expiresIn: opts?.expiresInSeconds ?? 300,
      });
    },

    async delete(key) {
      if (!isSafeStorageKey(key)) return;
      const { client, bucket } = await getClient();
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      await (client as { send: (c: unknown) => Promise<unknown> }).send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
      );
    },
  };
}
