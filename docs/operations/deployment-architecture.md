# CLUB-OPS — Deployment Architecture

Factual deploy flow at `dc14d10`. Two targets share one image: **Yandex Cloud VM** (canonical) and
**Railway / plain `docker run`** (single-container). Read-only survey — nothing was deployed.

## Flow (VM, canonical)
```
git push → CI (deploy-yandex.yml): build image, run check-runtime-packages inside it,
           push cr.yandex/<reg>/club-ops:<sha> and :main
   ↓
systemd timer (every 1 min) → deploy.sh:
   flock single-flight
   → preflight (env, docker, disk ≥2GB, network, volume)
   → registry auth (short-lived IAM token from VM metadata; temp DOCKER_CONFIG; no static key)
   → remote digest gate (deploy only if :main digest changed)
   → pg_dump -Fc BACKUP (abort if fails/empty; keep 7) ── local to /opt/club-ops/backups
   → docker pull <digest>
   → compose run --rm migrate   (prisma migrate deploy, ONE-SHOT, before app)
   → compose up -d postgres app caddy
   → health probe /api/health (Node, 120s)
       ok  → record STATE_FILE, prune old images (keep 5), done
       fail → roll APP back to previous image; DB migration NOT rolled back; backup path logged
```

## Flow (Railway / plain docker run)
`docker-entrypoint.sh`: `prisma migrate deploy` → `exec node server.js` (Next.js standalone = PID 1).
Migrations run **on start** inside the app container (no separate migrate step).

## Where each thing happens
| Concern | VM | Railway |
|---|---|---|
| Build | CI (GitHub Actions) → image | image |
| Prisma generate | in the image build (`build:prod`, prod schema) | same |
| Migrations | dedicated one-shot `migrate` service **before** app (`deploy.sh:220`) | `docker-entrypoint.sh` on app start |
| DATABASE_URL | `.env` on VM (postgres in `club_ops_postgres_data` volume) | Railway env |
| App/schema incompatibility | app can transiently run against a **newer** schema (migrate-before-app; no expand/contract gating) — ARCH-016 | same, and app auto-migrates itself on boot |
| Uploads | `STORAGE_PROVIDER` (default `local` → container FS, **lost on redeploy**; expected `s3`) — ARCH-017 | same |
| Logs | container stdout (docker/journald); **no structured logger, no error tracker** (OPS) | stdout |
| Secrets | `.env` on VM (root-owned); registry auth via metadata token (no static key) | Railway secrets |
| deploymentVersion | `APP_GIT_SHA`/`APP_DEPLOYMENT_ID`/`APP_ENVIRONMENT` baked at build → `/api/health` | `RAILWAY_*` → `/api/health` |

## Health / traffic
`GET /api/health` is **liveness only** (no DB call, `Cache-Control: no-store`) — reports process up +
version + provider readiness names. Docker HEALTHCHECK and the VM deploy gate both trust it. **No
readiness endpoint checks DB connectivity** (ARCH-015 / OPS) → an app that cannot reach the DB still
returns 200 and receives traffic.

## Rollback
- **App:** on health failure the deploy rolls the app container back to the previous image (`deploy.sh:257`). First deploy has no target.
- **DB:** the applied migration is **NOT** rolled back (documented `deploy.sh:8,262`); recovery = restore from the pre-deploy `pg_dump` backup (manual). Because migrations are additive (see `migration-risk-register.md`), the old app is generally compatible with the new schema, so an app-only rollback is usually safe.

## Zero-downtime
**Not** zero-downtime: `compose up -d app` recreates the app container (brief gap); migrations run
before the new app starts, so during the window the **old app serves against an already-migrated DB**.
Additive-only migrations keep this safe in practice, but it is not enforced (ARCH-016).

## Strengths (explicit)
Backup before every deploy; abort-on-empty-backup; single-flight lock; IAM-token registry auth (no
static key); digest gate (no redundant deploys); never deletes the postgres volume; never `prune -a`;
never prints secrets/DATABASE_URL. CI validates runtime packages (CVE floor) inside the image before push.

> Build-client risk → `prisma-build-matrix.md`. Migration risk → `migration-risk-register.md`. Backup
> gaps → `backup-policy.md`. Storage → `file-storage-durability.md`. Health split → `health-readiness-spec.md`.
