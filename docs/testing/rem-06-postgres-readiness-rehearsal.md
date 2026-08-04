# REM-06 — PostgreSQL Readiness Rehearsal (STAGING GATE)

Run on staging with a real PostgreSQL + the production Prisma client. Logic is proven
(`test:rem-06-readiness` 28/28 with mock clients); this is the real-DB proof.

> **Status in the CI sandbox: NOT EXECUTED** — no PostgreSQL. Provider/migration compatibility is
> proven by logic tests only until this passes.

## A. DB readiness (§27)
1. App built with the **prod** client; PostgreSQL available; no pending migrations.
2. `GET /api/health/ready` → 200 `ready`.
3. Stop PostgreSQL.
4. `GET /api/health/live` → 200 `alive`; `GET /api/health/ready` → 503 `not_ready` (`DB_UNREACHABLE`).
5. Restore PostgreSQL → `/ready` → 200 **without restarting the app**.
6. Introduce a pending migration (add a new migration dir, do NOT apply) → `/ready` → 503
   (`pending_migration`).
7. Apply the migration (`prisma migrate deploy`) → `/ready` → 200.

## B. Provider mismatch (§21, closes ARCH-013 operationally)
1. Deliberately regenerate the **dev (sqlite)** client into a prod build → `detectDbProvider` returns
   `sqlite` while `expected = postgresql` → `/ready` → 503 (`PROVIDER_MISMATCH`).
2. Regenerate the correct prod client → `/ready` → 200.

## C. Storage (§28)
1. S3 reachable → `/ready` → 200.
2. Block S3 → `/ready` → 503; file actions unavailable; **no local fallback**.
3. Restore S3 → `/ready` → 200. The readiness probe creates no orphan business objects.

## D. Deploy gate
1. Point `DATABASE_URL` at a down DB during deploy → `deploy.sh` never accepts the image (readiness
   never green) → rolls back to the previous image.
2. Malformed `DATABASE_URL` in production → app fails fast at startup; logs a safe code; no leak.

## Sign-off
G-READY-3..8 + G-READY-12 pass on staging PostgreSQL. Record: RTO of DB-down→recover, and that no
manual restart was needed. Only then are ARCH-015/OPS-003 CLOSED and ARCH-013/OPS-004 CLOSED.
