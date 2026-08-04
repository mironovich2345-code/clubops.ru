# REM-04 — Storage Architecture

The target object-storage design and how REM-04 enforces it.

## Layers
```
 upload action / route
        │  validate actor + scope + declared MIME + size + magic bytes
        ▼
 src/lib/storage/service.ts   putAndVerify(key, buf, mime)
        │  put → HEAD/exists → assert size → return {sha256, size, verified}
        ▼
 src/lib/storage/index.ts     getStorage()  ── production fail-fast ──▶ throws if
        │                                        STORAGE_PROVIDER != s3 or config incomplete
        ├── local-provider.ts  (dev/test only)  uploads/<key>
        └── s3-provider.ts     (production)     bucket[/prefix]/<key>  + SSE
        │  config from src/lib/storage/config.ts (STORAGE_S3_* ← S3_* fallback)
        ▼
 object storage (private bucket, versioning, lifecycle, SSE)
```

## Production enforcement (closes ARCH-017 / OPS-002 at the config layer)
- `validateStorageEnv(env, {isProduction})` is pure and returns machine error codes.
- In production, `provider !== "s3"` ⇒ `PRODUCTION_LOCAL_FORBIDDEN`; an incomplete S3
  config ⇒ `S3_CONFIG_INCOMPLETE:<names>`. `assertStorageConfigured()` throws on either,
  and `getStorage()` calls it in production — the app **cannot serve traffic on local disk**.
- Development/test keep `local` as the safe default; nothing changes for dev.

## Provider capabilities
| Method | Local | S3 | Used by |
|---|---|---|---|
| `put` | write under `uploads/` | PutObject + **SSE** (AES256 / aws:kms) | uploads |
| `get` | read file | GetObject | downloads (streamed through the app) |
| `exists` | fs stat | HeadObject | availability status |
| `head` | fs stat → size | HeadObject → size/ETag | upload verification, inventory |
| `list` | recursive walk | ListObjectsV2 | **read-only** inventory / reconciliation |
| `getSignedUrl` | null (use routes) | presigned GET, bounded TTL | optional direct download |
| `delete` | unlink | DeleteObject | non-financial lifecycle only |

## Encryption / privacy
- Server-side encryption on every upload (`STORAGE_S3_SERVER_SIDE_ENCRYPTION`, default
  `AES256`; `aws:kms` requires `STORAGE_S3_KMS_KEY_ID`).
- Private bucket, no public ACL. Credentials are server-only and never returned to callers
  or logged. The health endpoint exposes only the provider NAME, never bucket/endpoint/keys.
- Downloads stream through the app's authorized routes; a signed URL (when used) is
  per-object and short-lived (`STORAGE_SIGNED_URL_TTL_SECONDS`, ≤ 3600, default 300).

## What did NOT change
File authorization, tenant scope, invoice/refund/expense/payroll workflows, business
statuses, AI logic, original filenames in the UI, and historical file metadata. REM-04 is a
durability/key/integrity/recovery hardening only.

## Backward compatibility
Legacy per-module keys (`invoices/<hex>.ext`, `expense-docs/<hex>.ext`, …) remain valid and
readable (`isSafeStorageKey` accepts both shapes). New/migrated objects use the canonical
tenant-scoped immutable key (see `rem-04-object-key-spec.md`). The legacy `S3_*` env names are
still honored as a fallback so existing deployments keep working while migrating to
`STORAGE_S3_*`.
