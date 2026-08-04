# REM-04 — File Storage Baseline

Read-only assessment captured before any REM-04 change. **A file blob is not recoverable until a
restore is proven** — REM-03 backs up the DB (file *metadata*) but not the *blobs*.

## Git / build baseline
| Aspect | Value |
|---|---|
| HEAD | `ca7f5b1b4974e2b4b713a7642452869ae6a1ec12` |
| Branch | `main` |
| Origin divergence | 17 commits ahead of `origin/main` (local remediation not pushed) |
| Working tree | clean at capture |
| tsc | 0 errors (unchanged from REM-03 green) |
| prisma dev / prod | both valid |
| pilot:full | 3941/0 (REM-03 gauntlet) |
| build:prod | compiles (BUILD_EXIT=0 from REM-02; REM-03 added no `src/`/schema) |

## STORAGE_PROVIDER behavior (as-is)
- `src/lib/storage/index.ts` — `storageProviderName()` returns `"s3"` **only** when
  `process.env.STORAGE_PROVIDER === "s3"`, otherwise **`"local"` (the default)**.
- **There is NO production guard**: a production deploy with `STORAGE_PROVIDER` unset (or `local`)
  starts happily on ephemeral local disk → **ARCH-017** (local allowed in prod) and **OPS-002**
  (files lost on redeploy/restart/multi-instance). This is the central defect REM-04 closes.
- `getStorage()` is a per-instance singleton selecting local vs S3 provider.

## Current local paths
- Local provider root: `<cwd>/uploads/<key>` (`src/lib/storage/local-provider.ts`).
- Dev: `uploads/invoices/` exists (0 blobs in the current dev checkout — dev seed carries metadata,
  not committed blobs). No blobs are committed to git.

## Storage env contract (as-is — pre-REM-04)
- S3 provider reads **`S3_ENDPOINT`, `S3_REGION` (default `ru-central1`), `S3_BUCKET`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`** (`s3-provider.ts`). `forcePathStyle` hardcoded `true`.
- **No** `STORAGE_S3_*` names, **no** server-side-encryption, **no** key prefix, **no** signed-URL
  TTL env, **no** max-file-size env, **no** fail-fast when incomplete (throws only lazily on first use).

## Upload handlers (write paths)
| Module | Storage helper | Key prefix | Key form |
|---|---|---|---|
| Invoices | `invoice-storage.ts` (`storeInvoiceFile`/`persistInvoiceFile`) | `invoices/` | `invoices/<16-byte hex>.<ext>` |
| Expenses (legacy single) | `expense-storage.ts` | `expenses/` | `expenses/<16-byte hex>.<ext>` |
| Expenses v2 multi-doc | `expense-document-storage.ts` → `ExpenseDocument` | `expense-docs/` | `expense-docs/<32-byte hex>.<ext>` |
| Refunds v1 | `refund-storage.ts` (`documentsJson`) | `refunds/` | `refunds/<16-byte hex>.<ext>` |
| Refunds v2 slots | `refund-document-storage.ts` → `RefundDocument` | `refund-docs/` | `refund-docs/<32-byte hex>.<ext>` |
| Cash operations | `cash-document-storage.ts` → `CashOperationDocument` | `cash-docs/` | `cash-docs/<32-byte hex>.<ext>` |
| Sales reports | `sales-report-storage.ts` → `SalesReportDocument` | `sales-reports/` | `sales-reports/<16-byte hex>.<ext>` |
| Payroll proof | reuses expense/refund document paths | — | — |
| AI source files | invoice/expense buffers analyzed in-memory; no separate AI blob store | — | — |

**Every key is server-generated** via `crypto.randomBytes` — the client-declared filename is NEVER
the key (SEC-006 core already addressed). Invoices additionally use a `PendingInvoiceUpload`
compare-and-set (owner+scope+purpose+unconsumed+not-expired) so a client can never bind an invoice
to someone else's key. **Keys are NOT tenant-scoped** (no `companyId` segment) — collision safety
rests on randomness, not on a tenant prefix (REM-04 §5 hardens this).

## Download handlers (read paths)
- `src/lib/document-access.ts` — `safeDownloadHeaders`/`documentResponse`: Content-Type derived from
  the **server-set key extension** (allowlist), `X-Content-Type-Options: nosniff`,
  `Cache-Control: private, no-store`, RFC-6266 disposition, HTTP range support, audit de-dupe.
- Routes: `/api/invoices/[id]/file`, `/api/expenses/[id]/file`, `/api/expenses/[id]/documents/[docId]`,
  `/api/refunds/[id]/file`, `/api/sales-reports/[id]/file` — each does object-level authorization
  (`getXForContext` + storage-key regex) before streaming. Downloads stream **through the app**
  (server-side auth + audit); the S3 provider *can* mint a short signed URL but callers use routes.

## File metadata models
| Model | Key field | Integrity fields | Scope | Delete semantics |
|---|---|---|---|---|
| `Invoice` (inline) | `storageKey @unique` | `fileName` | company/club | field cleared |
| `PendingInvoiceUpload` | `storageKey @unique` | orig name/mime/size | company/club/user | single-use / TTL |
| `ExpenseDocument` | `storageKey @unique` | `sha256`, `sizeBytes`, `mimeType` | company/club | soft tombstone |
| `RefundDocument` | `storageKey @unique` | `sha256`, `sizeBytes` | company (via refund) | soft/superseded |
| Refund v1 `documentsJson` | JSON `storageKey[]` | none | company (via refund) | JSON edit |
| `CashOperationDocument` | `storageKey @unique` | `sha256`, `sizeBytes` | company/club | soft |
| `SalesReportDocument` | `storageKey` | — | company/club | field-level |
| `Expense` (legacy single) | `originalFileStorageKey` | `fileName` | company/club | field cleared |

**No model records**: `storageProvider`, `bucket`, `verificationStatus`/`verifiedAt`,
`uploadOperationKey` (idempotency), `supersedesFileId`, or a `migrationStatus`. REM-04 adds these
**additively** (no auto-backfill).

## File / blob counts (dev)
- Blobs on disk: **0** in the current dev checkout (no committed blobs).
- Metadata rows: counted read-only by `npm run audit:file-inventory` (added in REM-04); dev DB is a
  seed, not production. Known orphan/missing rows: to be enumerated by the inventory (none asserted
  here without the tool).

## Size / MIME validation (as-is)
- Per-module MAX sizes: invoices/expenses 10 MB, refund docs 10 MB/file (+40 MB/set), cash docs 10 MB,
  sales reports 15 MB/file. MIME allowlist jpg/png/webp/pdf (+xls/xlsx/csv for sales reports).
- Magic-byte signature check (`sniffDocumentSignature` / `detectSignatureMime`) rejects HTML/SVG/script
  disguised by a declared image MIME. HEIC detected and rejected with a precise error.

## Related findings (in scope)
- **OPS-002** — local storage may lose documents on redeploy (P0, REM-04 primary).
- **ARCH-017** — `STORAGE_PROVIDER=local` allowed in production (P0, REM-04 primary).
- **OPS-001** — full system restore impossible without blobs (PARTIALLY CLOSED by REM-03 for DB only).
- **OPS-016** — tenant-level file restore/export absent.
- **SEC-006** — client-trusted `storageKey` (core already server-generated; REM-04 hardens + guards).
- **DATA-004/011** — storageKey token / duplicate detection (P2 overlap).

## No-S3 sandbox constraint
This sandbox has **no MinIO/LocalStack/S3** and no real bucket. Per REM-04 §21/§27, the real
upload/download/restore rehearsal is **NOT EXECUTABLE here** → OPS-002 stays **PARTIALLY CLOSED**;
REM-04 ships enforced-config + tooling + pure-logic tests + documented live gates, exactly as REM-03
did for the PostgreSQL restore.
