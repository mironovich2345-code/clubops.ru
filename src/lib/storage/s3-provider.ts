import { type StorageProvider, isSafeStorageKey } from "./types";
import { resolveStorageConfig, type ResolvedS3Config } from "./config";

// S3-compatible provider for production. Works with any S3 API endpoint —
// designed for Russian object storage (Yandex Object Storage, Selectel, VK
// Cloud) as well as AWS. Credentials come only from the environment and are
// never returned to callers.
//
// Config is resolved through the REM-04 storage contract (STORAGE_S3_* with a
// legacy S3_* fallback), so a bucket PREFIX, server-side encryption and
// path-style addressing are all honored. The AWS SDK is imported dynamically so
// it is loaded only when STORAGE_PROVIDER=s3.

type Wire = { config: ResolvedS3Config; accessKeyId: string; secretAccessKey: string };

function readConfig(): Wire {
  const v = resolveStorageConfig();
  if (!v.s3) throw new Error("S3 storage is not configured");
  const missing: string[] = [];
  if (!v.s3.endpoint) missing.push("STORAGE_S3_ENDPOINT");
  if (!v.s3.bucket) missing.push("STORAGE_S3_BUCKET");
  // Values (not just presence) are read straight from env here; the contract has
  // already verified they are present, but we re-read to keep secrets out of the
  // shared config object.
  const accessKeyId = process.env.STORAGE_S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.STORAGE_S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY || "";
  if (!accessKeyId) missing.push("STORAGE_S3_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("STORAGE_S3_SECRET_ACCESS_KEY");
  if (missing.length) throw new Error(`S3 storage is not configured: missing ${missing.join(", ")}`);
  return { config: v.s3, accessKeyId, secretAccessKey };
}

/** Prepend the configured bucket prefix (if any) to a logical key. */
function withPrefix(cfg: ResolvedS3Config, key: string): string {
  return cfg.prefix ? `${cfg.prefix}/${key}` : key;
}

// Cache the client (and config) across requests within a server instance.
let clientPromise: Promise<{ client: unknown; wire: Wire }> | null = null;

async function getClient(): Promise<{ client: unknown; wire: Wire }> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const wire = readConfig();
      const { S3Client } = await import("@aws-sdk/client-s3");
      const client = new S3Client({
        endpoint: wire.config.endpoint,
        region: wire.config.region,
        forcePathStyle: wire.config.forcePathStyle,
        credentials: { accessKeyId: wire.accessKeyId, secretAccessKey: wire.secretAccessKey },
      });
      return { client, wire };
    })();
  }
  return clientPromise;
}

type Sendable = { send: (c: unknown) => Promise<unknown> };

export function createS3StorageProvider(): StorageProvider {
  return {
    name: "s3",

    async put(key, buffer, mime) {
      if (!isSafeStorageKey(key)) throw new Error("Unsafe storage key");
      const { client, wire } = await getClient();
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const enc =
        wire.config.serverSideEncryption === "aws:kms"
          ? { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: wire.config.kmsKeyId ?? undefined }
          : { ServerSideEncryption: "AES256" as const };
      await (client as Sendable).send(
        new PutObjectCommand({
          Bucket: wire.config.bucket,
          Key: withPrefix(wire.config, key),
          Body: buffer,
          ContentType: mime,
          ...enc,
        }),
      );
    },

    async get(key) {
      if (!isSafeStorageKey(key)) return null;
      const { client, wire } = await getClient();
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      try {
        const out = (await (client as Sendable).send(
          new GetObjectCommand({ Bucket: wire.config.bucket, Key: withPrefix(wire.config, key) }),
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
      const { client, wire } = await getClient();
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      try {
        await (client as Sendable).send(
          new HeadObjectCommand({ Bucket: wire.config.bucket, Key: withPrefix(wire.config, key) }),
        );
        return true;
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === "NoSuchKey" || name === "NotFound") return false;
        throw error; // AccessDenied / config errors must NOT look like "missing".
      }
    },

    async head(key) {
      if (!isSafeStorageKey(key)) return null;
      const { client, wire } = await getClient();
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      try {
        const out = (await (client as Sendable).send(
          new HeadObjectCommand({ Bucket: wire.config.bucket, Key: withPrefix(wire.config, key) }),
        )) as { ContentLength?: number; ETag?: string };
        return { size: out.ContentLength ?? 0, etag: out.ETag ? out.ETag.replace(/"/g, "") : null };
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === "NoSuchKey" || name === "NotFound") return null;
        throw error;
      }
    },

    async list(prefix, opts) {
      const { client, wire } = await getClient();
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const out = (await (client as Sendable).send(
        new ListObjectsV2Command({
          Bucket: wire.config.bucket,
          Prefix: withPrefix(wire.config, prefix),
          MaxKeys: opts?.max ?? 1000,
        }),
      )) as { Contents?: Array<{ Key?: string }> };
      const strip = wire.config.prefix ? wire.config.prefix + "/" : "";
      return (out.Contents ?? [])
        .map((o) => o.Key ?? "")
        .filter(Boolean)
        .map((k) => (strip && k.startsWith(strip) ? k.slice(strip.length) : k));
    },

    async getSignedUrl(key, opts) {
      if (!isSafeStorageKey(key)) return null;
      const { client, wire } = await getClient();
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const command = new GetObjectCommand({
        Bucket: wire.config.bucket,
        Key: withPrefix(wire.config, key),
        ResponseContentDisposition: opts?.downloadName
          ? `inline; filename="${opts.downloadName.replace(/["\r\n]/g, "")}"`
          : undefined,
      });
      return getSignedUrl(client as never, command as never, {
        expiresIn: opts?.expiresInSeconds ?? resolveStorageConfig().signedUrlTtlSeconds,
      });
    },

    async delete(key) {
      if (!isSafeStorageKey(key)) return;
      const { client, wire } = await getClient();
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      await (client as Sendable).send(
        new DeleteObjectCommand({ Bucket: wire.config.bucket, Key: withPrefix(wire.config, key) }),
      );
    },
  };
}
