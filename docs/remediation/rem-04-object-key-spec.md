# REM-04 — Object Key Specification

## Canonical key
```
<environment>/<companyId>/<entityType>/<entityId>/<fileId>/<contentHash>-<safeExtension>
```
Example: `production/ckco.../expense/ckexp.../a1b2.../<sha256>-pdf`

## Rules
- **Server-generated only.** Never derived from a client value and never from the original
  filename (the filename lives only in metadata). `buildObjectKey(...)` throws on any unsafe
  segment rather than silently sanitizing.
- **Tenant prefix.** The second segment is the owning `companyId` — defense-in-depth, not an
  authorization mechanism (authorization stays in the routes). A leaked key reveals its owning
  tenant only; it never grants access.
- **Immutable + collision-safe.** `fileId` is server-random and `contentHash` (sha256) pins the
  bytes. A new upload → a new `fileId` → a new key. **Objects are never overwritten.**
- **No path traversal.** Every segment is a strict ASCII-safe charset (`[a-z0-9-]`, sha256 hex,
  `[a-z0-9]{1,8}` extension); `..`, backslashes, spaces, uppercase and slashes-in-segments are
  rejected. `parseObjectKey` round-trips a valid key and returns `null` otherwise.
- **Unicode-safe.** Non-ASCII never enters the key; original (possibly Cyrillic) filenames are
  stored in metadata and emitted via RFC-6266 `filename*` on download.

## Entity types (allowlist)
`invoice · expense · refund · cash · sales-report · payroll · company · temp`

## Extensions (from MIME allowlist)
`jpg · png · webp · pdf · xls · xlsx · csv` (`safeExtensionFromMime`).

## Migration keys
The local→S3 migration builds a **deterministic** target key per source row
(`fileId = row.id`), so a replayed migration maps a given blob to the SAME key every time — a
retry never creates a duplicate object, and it never overwrites an existing object that has a
different hash (that is reported as a conflict). See `rem-04-local-to-s3-migration.md`.

## SEC-006 (client-trusted storageKey)
Every current write path already generates the key server-side (`crypto.randomBytes`), and
invoices additionally bind via `PendingInvoiceUpload` compare-and-set. REM-04 adds the
canonical builder + `isSafeStorageKey`/`parseObjectKey` guards and the inventory's cross-tenant
+ unsafe-key checks, so a client-supplied or malformed key is structurally impossible to honor.
