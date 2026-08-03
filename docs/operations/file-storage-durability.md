# CLUB-OPS — File Storage Durability (ARCH-017 / OPS-002)

Read-only assessment at `dc14d10`. `docs/audits/data/storage-risk.json`.

## Provider model
`src/lib/storage/index.ts` dispatches on `STORAGE_PROVIDER`: `s3` → `s3-provider.ts` (AWS S3-compatible),
anything else → `local-provider.ts` (container filesystem). **Default is `local`** and **nothing in code
refuses `local` in production** (no startup guard — confirmed scan `storageProdGuard=false`).

## What is stored
Uploaded invoice/expense/refund/sales-report documents (PDFs, images), the source files AI analyzes.
Blob bytes live on disk/S3; only metadata (name, mime, storageKey, hash) is in the DB.

## Durability by provider
| Concern | `local` (default) | `s3` (intended prod) |
|---|---|---|
| Survives redeploy? | **NO** — container FS is ephemeral; `compose up -d app` recreates the container → files gone (unless a named volume is mounted) | yes (external bucket) |
| Multi-instance shared? | **NO** — each container has its own FS | yes |
| Container restart deletes? | depends on volume mount; without a volume, yes | no |
| In backups? | **NO** (not dumped by `deploy.sh`) | bucket's own durability/versioning |
| Checksum | metadata `sha256` stored (not enforced on read) | same + S3 ETag |
| Object key collision | keys are unique per upload (`storageKey @unique`); tenant prefixing per the storage layer | same |
| Lifecycle/cleanup policy | none in repo | none defined |

## Mitigations present
- `deploy/docker-compose.production.yml` mounts a `club_ops_uploads` volume as a **fallback** so local uploads survive a redeploy *if* that compose file is used and the volume is mounted. But the intended prod config is S3 (`deploy/.env.production.example` sets `STORAGE_PROVIDER="s3"`), and the code does not enforce it.

## Findings (OPS-002)
1. **`STORAGE_PROVIDER=local` in production loses uploaded documents on every redeploy** unless a persistent volume is mounted — and nothing in code prevents an operator from running prod with `local`.
2. **Local files are in no backup** — a lost container FS = lost proofs/invoices with no recovery.
3. **S3 credentials accept empty with no boot validation** (`s3-provider.ts:23-24`) → a mis-set `STORAGE_PROVIDER=s3` fails only at the first upload, not at startup (OPS-012).
4. **No orphan-blob / lifecycle policy** — deleted document rows may leave blobs (and vice-versa); no reconciliation job.

## Recommendation (NOT implemented here)
Enforce `STORAGE_PROVIDER=s3` in production at startup (throw if `local`); validate S3 credentials at
boot; include uploads in the backup/DR story; add an orphan-blob reconciliation. Confirm the live
production value via `GET /api/health` → `storage` field ("local" or "s3").
