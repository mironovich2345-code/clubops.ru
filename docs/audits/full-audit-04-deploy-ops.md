# FULL AUDIT 4/6 — Deployment, Infrastructure, Backup, Restore, Operations (Findings)

Commit `dc14d10`. Read-only; **nothing deployed, no production mutated, no migration run on a real DB,
no schema/logic changed.** Evidence is file:line / config. Severity S0→S3; blocker yes/no/conditional.
Priorities in `docs/release/remediation-backlog-after-audit-04.md`. Supporting docs:
`docs/operations/*`, `docs/testing/{staging-migration,backup-restore}-rehearsal.md`,
`docs/audits/data/{deploy-readiness,migration-risks,env-contract,storage-risk,operations-findings}.json`.

## Severity roll-up
| Severity | Count | IDs |
|---|---|---|
| **S1 high** | 6 | OPS-001, 002, 003, 006, 013, 016 |
| **S2 medium** | 10 | OPS-004, 005, 007, 008, 010, 011, 012, 014, 015, 018 |
| **S3 low** | 2 | OPS-009, 017 |
| **S0 critical** | 0 | (OPS-001/002 are S1 but P0 — data-loss risk, conditional on the config used) |

## §10 Startup safety
| Condition | Behavior | Classification |
|---|---|---|
| DB unavailable at boot | app starts (health has no DB check); requests 500 | **unsafe success** (OPS-003) |
| Pending migrations | VM: migrate one-shot before app; Railway: entrypoint migrates then starts | acceptable (VM) / auto (Railway, ARCH-016) |
| Wrong/incompatible schema | app boots; errors at query | unsafe success (ARCH-016) |
| Missing required secret | **throws** (`env-secrets` fail-closed) | **fail fast** (good) |
| `STORAGE_PROVIDER=local` in prod | boots; files lost on redeploy | **unsafe success** (OPS-002) |
| Missing `SESSION_SECRET` in prod | **throws** | fail fast (good) |
| Missing SMTP | boots; OTP not delivered (dev transport) | degraded (login blocked) |
| Missing AI keys | boots; AI → mock | acceptable optional |
| Malformed `DATABASE_URL` | boots; **silently treated as sqlite** → row locks no-op | **unsafe success** (OPS-013) |

## §22 Multi-company operations
Shared deployment + shared DB + shared storage. **No tenant-scoped restore or export** (OPS-016):
recovering/exporting one company requires operating on the whole DB. `Company` has no soft-delete
(DATA-008) → accidental deletion is unrecoverable except by full-DB restore. No company-scoped
diagnostics beyond the `--company` filter on `audit:financial-reconciliation`. Archival = none at the
tenant level. **Operational tenant readiness is LOW** — fine for a handful of companies with careful
ops, risky at scale.

## §23 Capacity assumptions (to 10 companies / 50 clubs / 500 users / 1M OFD checks / 100k docs)
- **Fastest-growing tables:** `OfdReceiptImport` + `OfdReceiptItem` (1M checks → millions of item rows), `AuditLog` (294 write sites), `CashMovement`, `InvoicePayment`. Money is integer kopeks (no overflow at these scales).
- **Query hotspots** (from Audit-1): N+1 in `payroll/overview.ts` + `forecast.ts` (per-employee queries) — will slow at 500 users; analytics scans by date range.
- **Index-build risk:** any **future** plain `CREATE INDEX` on `OfdReceiptItem`/`AuditLog` will lock writes for the build (OPS-015) — must be `CONCURRENTLY` at these sizes.
- **Backup/restore duration:** grows with DB size; **untimed today** (OPS-001) — 1M checks makes a rehearsal essential.
- **Storage growth:** 100k documents on `local` is untenable (OPS-002) — S3 required.
- **DB pool:** single Postgres; pool sizing not tuned in repo — revisit at 500 concurrent users.
- **Not premature-optimizing:** at current beta scale all fine; these are the assumptions to validate before onboarding at volume.

---

## OPS-001 — No durable, proven backup (local-only, deploy-only, restore never tested)
- **Severity:** S1 · **Confidence:** proven · **Blocker:** yes (P0)
- **Evidence:** `deploy.sh:200` `pg_dump -Fc` **only on deploy**, to `/opt/club-ops/backups` **on the same VM/disk** as the postgres volume; 7 kept; **no off-site, no encryption** (`deploy-readiness.json`). Restore **never executed** (`backup-restore-rehearsal.md`).
- **Scenario:** VM/disk/region loss destroys the DB **and** all backups → **total data loss**. Quiet period (no deploys) → RPO grows unbounded. Restore unproven → RTO unknown.
- **Detection:** none (no backup-age alert). **Mitigation:** deploy aborts on backup failure (partial). **Remediation:** scheduled off-site encrypted backups + a rehearsed restore with recorded RPO/RTO. · **Deps:** — · **Effort:** M.

## OPS-002 — Uploaded files lost on redeploy; not in any backup
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional (P0) · **ARCH-017**
- **Evidence:** `STORAGE_PROVIDER` default `local`, **no prod guard** (`storage-risk.json`); container FS ephemeral; local files not dumped. **Remediation:** enforce S3 in prod at startup; back up uploads. · **Effort:** S.

## OPS-003 — Health is liveness-only; no DB readiness → traffic to a DB-less app
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional (P1) · **ARCH-015**
- **Evidence:** `src/app/api/health/route.ts` makes no DB call; deploy gate + LB trust it. **Remediation:** add `/api/health/ready` (`SELECT 1`) for traffic gating. · **Effort:** S.

## OPS-004 — build:prod leaves the postgres client; order-dependent, no restore
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no (P1) · **ARCH-013**
- **Evidence:** single un-pathed generator slot (`prisma-build-matrix.md`); no `postbuild`. **Remediation:** per-schema `output` paths or a `postbuild` dev-client restore + provider assertion at container start. · **Effort:** S.

## OPS-005 — No structured logging / request-id / error tracker
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no (P1) · **Evidence:** ad-hoc `console.*`, no logger/Sentry (`logging-spec.md`, `monitoring-alerts.md`). **Remediation:** structured logger + correlation id + error tracker (release-tagged, PII-scrubbed). · **Effort:** M.

## OPS-006 — Failed authorization is never audited or logged
- **Severity:** S1 · **Confidence:** proven · **Blocker:** no (P1) · **Evidence:** `requirePageAccess` (`access.ts:351`) silently redirects; `canAccessCompany/Club` return false silently — no `recordAudit`/log. **Scenario:** a cross-tenant probing incident (Audit-5) has **no trail**. **Remediation:** audit + alert on denied access. · **Effort:** S.

## OPS-007 — No monitoring / alerting
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no (P1) · **Evidence:** no metrics/uptime/error-tracker; only Docker health + stdout. **Remediation:** the alert matrix in `monitoring-alerts.md` (backup-failure, migration-failure, OFD-stale, reconciliation-anomaly, repeated-payment). · **Effort:** M.

## OPS-008 — No in-repo scheduler for OFD import + notification drain
- **Severity:** S2 · **Confidence:** proven · **Blocker:** conditional (P1)
- **Evidence:** only the deploy timer ships; OFD/daily + notifications/drain run **only if an operator configures an external timer** (`ofd/daily.ts`, docs). If unset → **OFD revenue never imports** and notifications never send. **Remediation:** ship a scheduler unit or document + monitor the requirement. · **Effort:** S.

## OPS-009 — OFD import concurrency guard is a check-then-insert race
- **Severity:** S3 · **Confidence:** proven · **Blocker:** no (P2) · **Evidence:** `importer.ts:71-75` findFirst-then-create, no lock; **bounded** by `dedupeKey` unique (double-run = wasted work, no double revenue). **Remediation:** a DB lock/unique on the run guard. · **Effort:** S.

## OPS-010 — OFD day uses server-local timezone (not MSK-pinned)
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no (P2) · **Evidence:** `daily.ts:19-35` server-local day. **Scenario:** wrong container TZ → imported day drifts. **Remediation:** pin the business timezone. · **Effort:** S.

## OPS-011 — `CRON_SECRET` missing from the deploy env example
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no (P2) · **ARCH-020** · **Evidence:** absent from `deploy/.env.production.example` (present only in root examples). **Remediation:** add it. · **Effort:** XS.

## OPS-012 — S3 credentials accept empty; no boot validation
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no (P2) · **Evidence:** `s3-provider.ts:23-24` `?? ""`. **Scenario:** mis-set `STORAGE_PROVIDER=s3` fails only at first upload. **Remediation:** validate at startup. · **Effort:** XS.

## OPS-013 — `DATABASE_URL` unvalidated → malformed URL silently becomes sqlite (row locks no-op)
- **Severity:** S1 · **Confidence:** proven · **Blocker:** conditional (P1)
- **Evidence:** `db-locking.ts:22` infers provider by regex; a non-`postgres://` URL → `"sqlite"` → `lockClubRow`/`lockCompanyRow` `FOR UPDATE` become no-ops. **Scenario:** a typo'd prod URL disables the concurrency guards protecting money writes. **Remediation:** validate the URL scheme at startup (fail fast). · **Effort:** XS.

## OPS-014 — Not zero-downtime; app can run against a newer schema
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no (P2) · **ARCH-016** · **Evidence:** `deploy.sh` migrate-before-app, no expand/contract gating. Safe while additive-only. **Remediation:** document/enforce expand-contract + a brief drain. · **Effort:** M.

## OPS-015 — Plain (non-CONCURRENT) index builds will write-lock at scale
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no (P2) · **Evidence:** `CONCURRENTLY` used nowhere; 5 recent migrations build plain indexes on populated tables (`migration-risk-register.md`). Fine at beta scale. **Remediation:** `CONCURRENTLY` on any large-table index. · **Effort:** S.

## OPS-016 — No tenant-scoped restore/export; Company deletion unrecoverable except full restore
- **Severity:** S1 · **Confidence:** proven · **Blocker:** no (P1) · **DATA-008** · **Evidence:** shared DB, no per-company export/restore; `Company` no soft-delete. **Remediation:** company-scoped export/restore + Company soft-delete. · **Effort:** L.

## OPS-017 — No production access matrix / rotation / offboarding documented
- **Severity:** S3 · **Confidence:** proven · **Blocker:** no (P2) · **Evidence:** none in-repo (template in `disaster-recovery-plan.md`). **Remediation:** document access matrix + secret rotation + offboarding. · **Effort:** S.

## OPS-018 — No in-app write-freeze / maintenance mode for money incidents
- **Severity:** S2 · **Confidence:** proven · **Blocker:** no (P1) · **FIN-004/005** · **Evidence:** the only containment is stopping the container (also stops reads). **Remediation:** a lightweight read-only/write-freeze toggle for incident containment. · **Effort:** M.

## What is sound (explicitly)
- Deploy is genuinely careful: **backup before every deploy** (abort on empty), single-flight flock, IAM-token registry auth (no static key), digest gate, never deletes the postgres volume, never `prune -a`, never prints secrets/DATABASE_URL, CI validates runtime packages (CVE floor).
- **App rollback** works; recent migrations are **additive/rollback-safe**.
- **Secrets fail-closed** in production; **no sensitive `NEXT_PUBLIC_*`**; OpenAI blocked in prod.
- **Audit trail** is strong (294 sites, all key fields); money ops idempotency exists where it matters (invoice payment, OFD dedupeKey, notification drain CAS).
- **A backup file is NOT treated as a proven restore** — the restore gate (OPS-001) is explicitly open.
