# REM-04 — Local → S3 Migration

`npm run migrate:files-to-s3` re-keys legacy local blobs into the canonical tenant-scoped
immutable scheme and moves them to durable object storage. **Safe, idempotent, reversible until
final acceptance.**

## Modes
| Mode | Effect | Guard |
|---|---|---|
| `--mode=dry-run` (default) | plan only, no I/O mutation | none |
| `--mode=report` | plan + tally | none |
| `--mode=copy` | upload objects (no metadata switch) | `--apply` (+ `--i-understand-production` in prod) |
| `--mode=verify` | compare remote hash to metadata | none-mutating |
| `--mode=finalize` | switch metadata to the new object **after verify** | `--apply` (+ prod flag) |

Also: `--company=<id>`, `--limit=N`, `--json`.

## Copy-then-verify-then-switch flow
1. Read metadata.
2. Resolve the local blob; compute sha256 + size.
3. Validate local integrity: recorded `sha256` must equal the actual bytes (else **conflict**).
4. Build the **deterministic** target key (`fileId = row.id`).
5. Upload the new immutable object (SSE) — never overwriting a different-hash object.
6. HEAD-verify the remote object (size, and hash on `verify`).
7. Update metadata (`storageProvider=s3`, `storageBucket`, new `storageKey`,
   `migrationStatus=migrated`) **only after** the remote verify succeeds.
8. **Keep the local blob** until final acceptance (a later, explicit cleanup).
9. Produce a mapping/report.

## Idempotency (§16) — `planFileMigration`
| Observed state | Action |
|---|---|
| already on s3, same hash | `noop` |
| already on s3, different hash | `conflict` (investigate) |
| local blob missing | `skip` (missing_local, reported) |
| remote object already exists (interrupted run) | `finalize-only` (resume; no duplicate) |
| DB update failed after upload | re-run → deterministic key → `finalize-only` (no duplicate object) |
| local present, no remote | `copy` |

Because the target key is deterministic per row, replay is always safe: a given blob resolves
to exactly one object key, so a retry cannot create a second object and cannot clobber a
correct one.

## Production procedure
Run `--mode=dry-run` and review the plan and any conflicts FIRST. Only then run `copy` and
`finalize` with `--apply --i-understand-production`, on a maintenance window, with a fresh DB
backup (REM-03) and a file manifest (`backup:files-manifest`) taken beforehand. Never bulk-merge
directly into production automatically. In this sandbox `copy`/`finalize` honestly refuse to run
(no reachable S3).
