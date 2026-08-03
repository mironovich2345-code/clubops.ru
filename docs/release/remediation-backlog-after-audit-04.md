# Remediation Backlog — after FULL AUDIT 4/6 (Deploy / Ops)

From `docs/audits/full-audit-04-deploy-ops.md` (OPS-###), linked to ARCH-/DATA-/FIN-. Target: before
**2026-08-18**. Nothing fixed during the audit. Effort XS/S/M/L. **Every backup/restore/DR change is
gated by a disposable-environment rehearsal** — a backup is not done until its restore is proven.

## P0 — release blockers (data-loss risk)
| ID | Task | Deps | Precondition | Rehearsal | Live gate | Effort |
|---|---|---|---|---|---|---|
| OPS-001 | Scheduled **off-site, encrypted** `pg_dump` (fixed RPO) + a **rehearsed restore** with recorded RPO/RTO | — | disposable Postgres | **`backup-restore-rehearsal.md` Part A must PASS** | yes | M |
| OPS-002 | Enforce `STORAGE_PROVIDER=s3` in production at startup (throw on `local`); include uploads in the backup story | ARCH-017 | S3 bucket | upload+restore a file | yes (`/api/health` storage=s3) | S |

## P1 — before 18 Aug
| ID | Task | Deps | Effort |
|---|---|---|---|
| OPS-003 | Add `/api/health/ready` (`SELECT 1`) and gate LB traffic + deploy health on it (keep liveness separate) | ARCH-015 | S |
| OPS-013 | Validate `DATABASE_URL` scheme at startup (fail fast; prevent silent sqlite → row-locks no-op) | — | XS |
| OPS-006 | Audit + alert on **failed authorization** (record denied access) | Audit-5 | S |
| OPS-008 | Ship a scheduler unit for OFD import + notification drain (or document + monitor the external timer) | — | S |
| OPS-016 | Company-scoped export/restore tooling + `Company` soft-delete (recoverable deletion) | DATA-008 | L |
| OPS-018 | Lightweight in-app write-freeze / maintenance mode for money-incident containment | FIN-004/005 | M |
| OPS-004 | Per-schema Prisma `output` paths (or `postbuild` dev-client restore) + provider assertion at container start | ARCH-013 | S |
| OPS-005 | Structured logger + correlation id + error tracker (release-tagged, PII-scrubbed) | — | M |
| OPS-007 | Minimal monitoring + alerts (backup-failure, migration-failure, OFD-stale, reconciliation-anomaly, repeated-payment) | — | M |

## P2 — after launch
| ID | Task | Effort |
|---|---|---|
| OPS-009 | DB lock/unique on the OFD import run-guard | S |
| OPS-010 | Pin OFD business timezone (MSK), not server-local | S |
| OPS-011 | Add `CRON_SECRET` to `deploy/.env.production.example` | XS |
| OPS-012 | Validate S3 credentials at startup | XS |
| OPS-014 | Document/enforce expand-contract migrations + deploy drain | M |
| OPS-015 | `CREATE INDEX CONCURRENTLY` on any large-table index | S |
| OPS-017 | Document production access matrix + secret rotation + offboarding | S |

## Gating rehearsals (run on disposable environments — NOT executed in this audit)
- **`staging-migration-rehearsal.md`** — before any production migration (NOT EXECUTED here — no Postgres).
- **`backup-restore-rehearsal.md` Part A** — before relying on OPS-001 (NOT EXECUTED here).

## Coupling to prior audits
OPS-002→ARCH-017; OPS-003→ARCH-015; OPS-004→ARCH-013; OPS-011→ARCH-020; OPS-014→ARCH-016;
OPS-016→DATA-008; OPS-018→FIN-004/FIN-005; OPS-006→Audit-5 (security). Sequence: prove backup/restore
(OPS-001) and protect files (OPS-002) **first** — they are the recovery floor everything else assumes.
