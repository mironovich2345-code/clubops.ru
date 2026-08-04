// Server-generated, tenant-scoped, immutable object-key design (REM-04 §5).
//
// A key is NEVER derived from a client-supplied value and NEVER from the original
// filename (the filename lives only in metadata). The structure carries a tenant
// prefix for defense-in-depth and an entity path for auditability:
//
//   <environment>/<companyId>/<entityType>/<entityId>/<fileId>/<contentHash>-<ext>
//
// It is collision-safe (fileId is server-random; contentHash pins the bytes),
// immutable (a new upload → a new fileId → a new key; never overwrite), and
// Unicode-safe (every segment is a strict ASCII-safe charset). The path is NOT an
// authorization mechanism — authorization stays in the routes — but the tenant
// prefix means a leaked key still reveals its owning tenant only, never grants it.
//
// PURE: no crypto/random here except the explicit `newFileId` helper, so the key
// builder is fully deterministic and unit-testable.

import { randomBytes } from "node:crypto";

/** Entity kinds allowed in an object key. Additive; extend as new file domains land. */
export const OBJECT_ENTITY_TYPES = [
  "invoice",
  "expense",
  "refund",
  "cash",
  "sales-report",
  "payroll",
  "company",
  "temp",
] as const;
export type ObjectEntityType = (typeof OBJECT_ENTITY_TYPES)[number];

const SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,127}$/; // cuid / slug-safe, no dots/slashes
const HASH_RE = /^[a-f0-9]{64}$/; // sha256 hex
const EXT_RE = /^[a-z0-9]{1,8}$/;
const ENV_RE = /^[a-z0-9-]{1,32}$/;

/** MIME → safe lowercase extension (allowlist). Mirrors the per-module maps. */
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "application/csv": "csv",
};

export function safeExtensionFromMime(mime: string): string | null {
  return MIME_EXT[mime] ?? null;
}

/** A fresh, unguessable file id (server-only source of key randomness). */
export function newFileId(): string {
  return randomBytes(16).toString("hex"); // 32 hex chars
}

export type ObjectKeyParts = {
  environment: string;
  companyId: string;
  entityType: ObjectEntityType | string;
  entityId: string;
  fileId: string;
  contentHash: string; // sha256 hex (64)
  ext: string; // safe extension (no dot)
};

function isEntityType(v: string): v is ObjectEntityType {
  return (OBJECT_ENTITY_TYPES as readonly string[]).includes(v);
}

/**
 * Build a canonical object key. THROWS on any unsafe/malformed segment rather than
 * silently sanitizing — a bad tenant/entity id is a programming error, not user
 * input to be cleaned. The returned key never contains "..", backslashes, spaces,
 * uppercase, or the original filename.
 */
export function buildObjectKey(parts: ObjectKeyParts): string {
  const environment = parts.environment.toLowerCase();
  if (!ENV_RE.test(environment)) throw new Error("Unsafe object key: environment");
  if (!SEGMENT_RE.test(parts.companyId)) throw new Error("Unsafe object key: companyId");
  if (!isEntityType(parts.entityType)) throw new Error(`Unsafe object key: entityType (${parts.entityType})`);
  if (!SEGMENT_RE.test(parts.entityId)) throw new Error("Unsafe object key: entityId");
  if (!SEGMENT_RE.test(parts.fileId)) throw new Error("Unsafe object key: fileId");
  if (!HASH_RE.test(parts.contentHash)) throw new Error("Unsafe object key: contentHash");
  const ext = parts.ext.toLowerCase();
  if (!EXT_RE.test(ext)) throw new Error("Unsafe object key: ext");
  return `${environment}/${parts.companyId}/${parts.entityType}/${parts.entityId}/${parts.fileId}/${parts.contentHash}-${ext}`;
}

/** Parse a canonical key back to its parts, or null if it is not one. */
export function parseObjectKey(key: string): ObjectKeyParts | null {
  if (typeof key !== "string" || key.length > 512 || key.includes("..") || key.includes("\\")) return null;
  const segs = key.split("/");
  if (segs.length !== 6) return null;
  const [environment, companyId, entityType, entityId, fileId, tail] = segs;
  const dash = tail.lastIndexOf("-");
  if (dash <= 0) return null;
  const contentHash = tail.slice(0, dash);
  const ext = tail.slice(dash + 1);
  if (!ENV_RE.test(environment)) return null;
  if (!SEGMENT_RE.test(companyId)) return null;
  if (!isEntityType(entityType)) return null;
  if (!SEGMENT_RE.test(entityId)) return null;
  if (!SEGMENT_RE.test(fileId)) return null;
  if (!HASH_RE.test(contentHash)) return null;
  if (!EXT_RE.test(ext)) return null;
  return { environment, companyId, entityType, entityId, fileId, contentHash, ext };
}

/** True iff `key` is a canonical REM-04 tenant-scoped object key. */
export function isTenantScopedObjectKey(key: string): boolean {
  return parseObjectKey(key) !== null;
}

/** Extract the owning companyId from a canonical key (for inventory cross-tenant checks). */
export function companyIdFromObjectKey(key: string): string | null {
  return parseObjectKey(key)?.companyId ?? null;
}
