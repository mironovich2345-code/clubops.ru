# CLUB-OPS — Pilot Release Checklist & Gate

## Release gate (Phase 25)

| Gate condition | State |
|---|---|
| No open P0 findings | ✅ none |
| No open auth/authz P1 | ✅ none |
| No open tenant-isolation P1 | ✅ none |
| No open financial-integrity P1 | ✅ F-001 fixed + regression |
| `npm run build` passes | ✅ |
| `npm run build:prod` passes | ✅ |
| `npm run pilot:full` passes | ✅ 76/76 |
| Production migration path valid | ✅ `prisma migrate deploy` (prod schema); migration added for every model |
| APP_URL behavior valid | ✅ https-required, prod invite guard, no origin fallback |
| OTP + Sessions regression pass | ✅ pilot:otp 18, pilot:sessions 13 |
| Invitation lifecycle | ✅ link guard + email-match + single-use (browser walk-through pending) |
| Role matrix | ✅ high-risk boundaries proven; full harness = follow-up |
| Critical financial workflow | ✅ spend/debt/budget invariants + F-001 |
| Document access tests | ✅ authz-before-stream, key validation (code-verified) |
| Backup plan exists | ⚠️ exists but **restore NOT verified** (condition) |

## Verdict: **READY WITH CONDITIONS**

The code gate passes. Remaining items are operational and must be done at/before go-live; none are open code defects.

## Pre-go-live operational checklist

- [ ] Railway env set: `DATABASE_URL` (Postgres), `SESSION_SECRET`, `OTP_SECRET` (DISTINCT from SESSION_SECRET), `APP_URL=https://pilot.clubops.ru`, `SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM`.
- [ ] `OTP_TEST_TRANSPORT` is UNSET in production.
- [ ] `AI_PROVIDER` + keys set only if AI is desired; otherwise leave unset (safe mock, no external calls).
- [ ] `prisma migrate deploy --schema=prisma/production/schema.prisma` runs before app start and a failed migration blocks startup.
- [ ] DNS: `pilot.clubops.ru` → Railway; Railway domain kept as technical fallback (no forced redirect); `clubops.ru` reserved for future marketing (not configured here).
- [ ] One live OTP email delivered and verified on the deployed domain.
- [ ] Backup enabled + one isolated restore test completed (see runbook) → flip backup block to verified.
- [ ] Manual smoke: login (password+OTP), invite→register→OTP→accept, two-device session revocation, a closed-month mutation is rejected, open a document, view dashboard debt for a club with a chief-approved unpaid invoice (should now include it).

## Per-future-customer reminder (architecture)

Each external customer = its own deployment, database, storage bucket, domain, and **unique** `SESSION_SECRET`/`OTP_SECRET`. Cookies are host-only; never set `Domain=.clubops.ru`. This pilot deployment is for the current client only.

## Recommended next task

A focused **observability + safe performance-instrumentation** pass (gated `requestId`/duration tracing, structured logs, alert recommendations) PLUS completing the **isolated backup-restore drill** — both are the highest-value non-blocking items. Defer the full role×action test harness and a DB-backed password-attempt limiter to a subsequent task.
