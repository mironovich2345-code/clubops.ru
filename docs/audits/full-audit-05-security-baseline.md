# FULL AUDIT 5/6 — Baseline (Security, Tenant Isolation, IDOR, Auth, File Access)

Frozen state. **No production was targeted, no production data mutated, no schema/RBAC changed, no
destructive/penetration testing, no real email, no money operation.** Read-only analysis + safe
local synthetic tests only.

## Audited commit
- **HEAD:** `eb8a8f64f8baef26c92d8333008af17521f9b717`
- **Branch:** `main` · **vs origin/main:** 11 ahead / 0 behind (audits 3–4 committed locally, **not pushed**) · **tree:** clean.
- **Audit date:** 2026-08-03.

## Build / test baseline (at HEAD `eb8a8f6`)
| Gate | Result |
|---|---|
| `tsc --noEmit` | clean (0 errors) |
| `prisma validate` dev (sqlite) | valid |
| `prisma validate` prod (postgres) | valid |
| `pilot:full` | 3768 passed / 0 failed across 84 suites (re-confirmed at close) |
| `build:prod` | compiled at Audit-4 close; application code unchanged since (re-run at this audit's close) |

## Security surface inventory
- **Roles (7):** owner, general_director, regional_director, manager, chief_accountant, accountant, marketer. Plus inactive/archived users. Authorization = **capabilities + page access**, re-derived from `CompanyUserAccess`/`ClubUserAccess` **fresh every request** (`access.ts`), never a token snapshot.
- **API routes:** 17 (`src/app/api/**/route.ts`) — 5 file-download, 5 xlsx template (currently 404), cron/ofd/daily, notifications/drain, telegram/webhook, health, me/access, export routes (404).
- **Server actions:** ~263 across 62 `"use server"` files (the primary mutation surface — Next.js server actions, not public REST).
- **File routes:** `invoices|expenses|refunds|sales-reports/[id]/file` + `expenses/[id]/documents/[docId]`.
- **Auth/session modules:** `session.ts`, `tokens.ts`, `otp.ts`, `login-challenge.ts`, `action-challenge.ts`, `account-recovery.ts`, `account-container.ts`, `invite-service.ts`, `access.ts`, `rate-limit.ts`, `middleware.ts`.

## Open findings carried in (Audits 1–4) relevant to security
- **ARCH-005** ~92 id-keyed writes rely on manual tenant scope (the central isolation mechanism this audit verifies).
- **ARCH-002/003/004** money write-paths without full transaction/idempotency → replay/double-effect surface.
- **DATA-007/025** scalar-only models, no DB relations (isolation is app-enforced, not DB-enforced).
- **DATA-008** Company hard-delete. **DATA-010** obligation.employeeId type confusion.
- **OPS-006** failed authorization **not logged** (no security-event trail).
- **OPS-013** `DATABASE_URL` may silently switch to sqlite (disables `FOR UPDATE` guards).
- **OPS-016/018** no tenant-scoped restore/export; no write-freeze for a money incident.

## Methodology & guardrails
- Four parallel read-only investigation streams (auth/sessions/invites; tenant reads/writes + mass-assignment; files/upload/download/XSS/SSRF/traversal; financial-actions/AI/cron/headers/rate-limit).
- Static scanners (`npm run audit:security-scope`) → read/write-scope, mass-assignment, XSS sinks, raw SQL, file-route auth, headers.
- **Executed** synthetic IDOR test (`npm run audit:idor-matrix`) against a **disposable COPY** of the dev sqlite DB (2 synthetic tenants; deleted after) — proves the scope filter isolates and that unscoped raw-id access would cross tenants.
- **NOT done:** any production request, any RBAC/schema change, any destructive test, any real email/money op.

## Scope of changes made by this audit (must remain true at completion)
Added: read-only security scanners (`scripts/audit-security-scope.mjs`, `scripts/audit-idor-matrix.mjs`
— disposable-copy only), an audit pilot, and docs under `docs/security/`, `docs/audits/`, `docs/release/`.
**NOT** changed: any `src/**` logic, `prisma/**`, RBAC, or production data. Secret values are never printed.
