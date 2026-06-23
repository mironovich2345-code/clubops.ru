# CLUB-OPS — Test Matrix

`npm run pilot:full` runs all suites with a fail-closed production guard (refuses unless `DATABASE_URL` is a local `file:` sqlite URL and `NODE_ENV!=="production"`). Latest: **76 checks passed, 0 failed across 5 suites** (deterministic over repeated runs).

| Suite | Command | Checks | Covers |
|---|---|---|---|
| APP_URL / invitations | `pilot:appurl` | 12 | URL validation (https required in prod, trailing slash, dev localhost default); production invite guard (valid→pilot.clubops.ru link, missing/invalid→sanitized error & no link; dev→localhost link) |
| Email OTP | `pilot:otp` | 18 | no plaintext OTP stored; HMAC digest; constant-time match; wrong/expired/locked; resend invalidates old code; one-time + concurrent-safe consume; emailVerifiedAt set on first OTP; session only after OTP; inactive blocked; cleanup; system email-change/2FA-reset |
| Sessions / revocation | `pilot:sessions` | 13 | tokenHash-only storage; revoked/expired/inactive invalid; list/count exclude them; revoke-others keeps current; revoke-all; tenant isolation; deactivation invalidates with history retained |
| Club / LegalEntity | `pilot:club` | 27 | atomic creation; duplicate identity (Company+City+name, case/space); cross-Company/inactive/wrong-type denial; one-active-per-type; shared entity across clubs; concurrent create/replace → exactly one; history preserved; no partial rows |
| Financial integrity | `pilot:financial` | 6 | F-001 regression: chief-approved counted in budget-used + debt; draft/rejected/paid handled correctly; refund debt |

## Coverage mapping to audit phases

- Phase 3 (auth/OTP/session): `pilot:otp`, `pilot:sessions`.
- Phase 4 (registration/invitations): `pilot:appurl` (invite link guard) + code review (acceptInvite email-match, single-use token); browser walk-through pending.
- Phase 5 (roles/permissions): `pilot:sessions` (manage authority), `pilot:club` (owner-only assignment); full role×action harness = follow-up.
- Phase 6 (tenant isolation): `pilot:sessions` (cross-user), `pilot:club` (cross-Company denial); plus static audit (see SECURITY_AUDIT §2).
- Phase 8 (Club/LegalEntity): `pilot:club`.
- Phase 9 (financial): `pilot:financial` + static formula audit (FINANCIAL_INVARIANTS).
- Phase 16 (domain/cookie): `pilot:appurl` + static.

## Not covered by automation (manual / live required)

- Real SMTP delivery + timeout behavior (needs a live mail server).
- Browser session-revocation across two devices; invite→register→OTP→accept end-to-end UI.
- Closed-month mutation rejection through the UI.
- PostgreSQL `FOR UPDATE` concurrency (dev is SQLite; production path verified by code, needs a staging Postgres run).
- File upload of malicious/oversized samples through the live UI (limits verified in code).

## Conventions

- All pilots use fixed `pilot-*` ids and clean up before+after; none connect to production.
- Failure → non-zero exit; concise final summary; no secrets/OTP printed.
- SQLite cannot reproduce Postgres row-locking; the club concurrency suite uses a busy-retry shim and documents that the production guarantee is the Postgres `FOR UPDATE` path.
