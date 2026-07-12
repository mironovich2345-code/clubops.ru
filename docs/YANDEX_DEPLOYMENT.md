# CLUB-OPS — Production deployment on Yandex Cloud

Automated delivery: **push to `main` → GitHub Actions builds & pushes an image to
Yandex Container Registry → the VM's systemd timer pulls the new `:main` digest,
backs up the DB, migrates, updates the app, health-checks, and rolls back on
failure.** The app is never built on the VM.

> This document contains **no secret values**. All secrets live only in
> `/opt/club-ops/.env` on the server and in GitHub Actions Secrets.

---

## 1. Architecture

```
 Developer ──push main──▶ GitHub Actions (.github/workflows/deploy-yandex.yml)
                              │  npm ci → checks → docker build (standalone) 
                              │  docker login cr.yandex (json_key)
                              ▼
                     Yandex Container Registry
                     cr.yandex/<registry-id>/club-ops:<sha>
                     cr.yandex/<registry-id>/club-ops:main
                              ▲ pull (:main)
   ┌──────────────────────────┼──────────────────────────────── Yandex VM (Ubuntu 24.04)
   │  systemd timer (1 min) ─▶ deploy/deploy.sh                  158.160.206.218
   │     lock → preflight → digest-gate → pg_dump backup →       (open: 22, 80, 443)
   │     migrate (one-shot) → app+caddy up → /api/health → rollback-on-fail
   │
   │  docker network: club_ops_internal (external)
   │  ┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌───────────────┐
   │  │  caddy   │──▶│   app    │──▶│  postgres 16 │   │  migrate (1x) │
   │  │ 80/443   │   │ :3000    │   │ club-ops-    │   │ prisma migrate│
   │  │ (public) │   │(internal)│   │ postgres     │   │ deploy        │
   │  └──────────┘   └──────────┘   └──────┬───────┘   └───────────────┘
   │        auto-HTTPS                     │ volume: club_ops_postgres_data (external)
   └───────────────────────────────────────┼─────────────────────────────────────────
                                            ▼
                        Yandex Object Storage (S3, private)
                        endpoint https://storage.yandexcloud.net
                        bucket  club-ops-prod-documents-7f3a9c
```

- **App**: Next.js 15 (App Router) standalone server, non-root, port 3000, **internal only**.
- **DB**: PostgreSQL 16 container `club-ops-postgres`, data on the **pre-existing external** volume `club_ops_postgres_data`, port 5432 **not published**.
- **Files**: S3 (`STORAGE_PROVIDER=s3`) — the container filesystem is ephemeral.
- **Public entrypoint**: Caddy only (80/443, automatic HTTPS for `SITE_DOMAIN`).

---

## 2. Resources that already exist (do NOT recreate)

- Ubuntu 24.04 VM, static IP **158.160.206.218**, Docker + Compose installed, firewall allows only **22/80/443**.
- PostgreSQL 16 container **club-ops-postgres**, DB **clubops**, user **clubops**, compose dir **/opt/club-ops**, external network **club_ops_internal**, external volume **club_ops_postgres_data** (5432 not published).
- Private Object Storage bucket **club-ops-prod-documents-7f3a9c**, endpoint **https://storage.yandexcloud.net**, region **ru-central1**.

**Never** delete / recreate / rename the postgres volume; never publish 5432/3000.

## 3. Resources still to create (manual, in Yandex Cloud console/CLI)

1. **Container Registry** (one registry in your folder). Note its **registry id**.
2. **CI service account** with role `container-registry.images.pusher` on that registry → create an **authorized key (JSON)** for it. This JSON becomes the `YC_SA_KEY_JSON` GitHub Secret. Push-only.
3. **VM pull access** — already provisioned: the service account **`club-ops-vm`** is
   **attached to the VM** with only `container-registry.images.puller` on this
   registry. The VM authenticates by fetching a **short-lived IAM token from the
   instance metadata service** at deploy time (see §4a). **No static key, no JSON
   key, and no persistent `~/.docker/config.json` are stored on the VM.** Do NOT
   run `yc container registry configure-docker` (that would persist credentials).

> The two accounts use **different auth schemes** on purpose: CI (GitHub Actions)
> pushes with an authorized-**key JSON** (`YC_SA_KEY_JSON`); the VM pulls with a
> **metadata IAM token** from its attached SA. CI can push but not pull-to-run;
> the VM can pull but not push, and holds no long-lived registry secret.

---

## 4. GitHub Secrets (Repository → Settings → Secrets and variables → Actions)

| Secret | Purpose | Notes |
|---|---|---|
| `YC_REGISTRY_ID` | Container Registry id used in the image path `cr.yandex/<id>/club-ops` | not secret-sensitive, but kept as a secret to avoid leaking infra ids in logs |
| `YC_SA_KEY_JSON` | Authorized-key JSON of the **CI push** service account | used with `docker login --username json_key --password-stdin cr.yandex`; never printed |

Do not add S3 keys, DB passwords, SMTP or OpenAI keys to GitHub — they belong only in `/opt/club-ops/.env`.

---

## 4a. Registry authentication (VM = metadata IAM token; CI = key JSON)

Two independent schemes — the VM never holds a long-lived registry secret:

| | GitHub Actions (push) | Production VM (pull) |
|---|---|---|
| Identity | CI service account (pusher) | attached SA **club-ops-vm** (puller) |
| Credential | `YC_SA_KEY_JSON` (GitHub Secret) | short-lived **IAM token** from metadata |
| `docker login` | `--username json_key --password-stdin` | `--username iam --password-stdin` |
| Stored on VM? | no | **no** (temp `DOCKER_CONFIG`, deleted after) |

**How the VM authenticates (in `deploy.sh`):**
1. After preflight and **before** any registry access, it creates a private temp
   `DOCKER_CONFIG` (`mktemp -d`, `umask 077`, mode 700) and exports it.
2. It fetches a fresh token from the metadata service:
   ```
   curl -s --fail --connect-timeout 3 --max-time 8 --retry 3 \
     -H 'Metadata-Flavor: Google' \
     http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token
   ```
   The JSON is parsed with `python3` (validates `access_token` + `expires_in`);
   the raw response and the token are **never logged**.
3. `printf '%s' "$IAM_TOKEN" | docker login --username iam --password-stdin cr.yandex`
   (token via **stdin**, never as a process argument).
4. It resolves the **remote** `:main` digest (`docker buildx imagetools inspect`,
   manifest-inspect fallback) and pulls only if it changed; it re-authenticates
   right before the pull so a long backup cannot outlive the token.
5. On **any** exit/signal a cleanup trap runs `docker logout cr.yandex`, removes
   the temp `DOCKER_CONFIG`, and unsets `IAM_TOKEN` / `DOCKER_CONFIG`. Nothing is
   left in `/root/.docker/config.json` or `/home/*/.docker/config.json`.

**Manual verification** (does nothing destructive):
```bash
sudo /opt/club-ops/deploy.sh --check      # tests metadata token + temp login + no persistent creds
```
One-off manual login test (always with a temp config; clean up after):
```bash
export DOCKER_CONFIG="$(mktemp -d)"; chmod 700 "$DOCKER_CONFIG"
IAM_TOKEN="$(curl -s -H 'Metadata-Flavor: Google' \
  http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
printf '%s' "$IAM_TOKEN" | docker login --username iam --password-stdin cr.yandex
docker logout cr.yandex; rm -rf "$DOCKER_CONFIG"; unset IAM_TOKEN DOCKER_CONFIG
```

**Confirm there are no persistent credentials:**
```bash
sudo test ! -f /root/.docker/config.json || sudo grep -q cr.yandex /root/.docker/config.json && echo "LEAK" || echo "clean"
ls -la /home/*/.docker/config.json 2>/dev/null || echo "none"
```

**Inspect the journal without exposing secrets** (the script never prints tokens):
```bash
journalctl -u club-ops-deploy.service -n 200 --no-pager | grep -iE 'auth|error|deploy'
```

**Troubleshooting:**
- *Metadata endpoint error / token empty*: confirm the SA is attached
  (`curl -s -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/instance/service-accounts/`),
  that `network-online.target` is reached, and that egress to `169.254.169.254` is allowed.
- *`docker login` rejected*: the SA lost the `container-registry.images.puller`
  role, or was detached. Re-attach `club-ops-vm` / re-grant the role on the
  registry — no change to the VM files is needed; the next timer run recovers.

---

## 5. Runtime environment (`/opt/club-ops/.env` on the server)

Derived from the app's real `process.env` usage. Template: `deploy/.env.production.example`. **Names only below — never commit values.**

**Deployment / image**
- `APP_IMAGE_REPO` — e.g. `cr.yandex/<registry-id>/club-ops` (deploy.sh appends `:main`). **required**
- `SITE_DOMAIN` — public domain Caddy serves + gets a cert for. **required for HTTPS**
- `APP_URL` — `https://<domain>` (absolute links / email). **required**
- `APP_ENVIRONMENT` — `production` (health metadata; also set by compose). optional
- `NODE_ENV` — `production`. optional (image already sets it)

**PostgreSQL** (host = `club-ops-postgres`)
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` — **required**
- `DATABASE_URL` — `postgresql://clubops:…@club-ops-postgres:5432/clubops?sslmode=disable` (internal network → TLS not required). **required**

**Sessions / OTP / recovery** (all distinct, `openssl rand -hex 32`)
- `SESSION_SECRET` — **required**
- `OTP_SECRET` — required for email OTP
- `ACCOUNT_RECOVERY_SECRET` — required for account deletion/recovery (≥32 chars)

**Object Storage**
- `STORAGE_PROVIDER=s3` — **required** (otherwise files land on the ephemeral disk)
- `S3_ENDPOINT=https://storage.yandexcloud.net`, `S3_REGION=ru-central1`, `S3_BUCKET=club-ops-prod-documents-7f3a9c` — **required**
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — **required** (static access key for a storage SA)

**SMTP**
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` — required for login/OTP/email-change/password-change.

**AI** (optional; off by default)
- `AI_PROVIDER` (empty → mock), `OPENAI_API_KEY`, `OPENAI_MODEL`, `INVOICE_AI_PRIMARY_MODEL`, `INVOICE_AI_FALLBACK_MODEL`, `INVOICE_AI_TIMEOUT_MS`, `RU_AI_ENDPOINT`, `RU_AI_API_KEY`.

`APP_GIT_SHA` is **not** in `.env` — it is baked into the image by CI and surfaces at `/api/health`.

---

## 6. First-time setup (manual, once)

On the server, as a sudo user, from a checkout of this repo:

```bash
# 1) Create /opt/club-ops/.env from the template and fill REAL values.
sudo mkdir -p /opt/club-ops
sudo cp deploy/.env.production.example /opt/club-ops/.env
sudo chmod 600 /opt/club-ops/.env
sudo nano /opt/club-ops/.env         # fill secrets (never commit these)

# 2) Registry pull auth is AUTOMATIC via the attached SA (club-ops-vm) + metadata
#    token — nothing to configure. Do NOT run `configure-docker` (it would persist
#    a credential). Verify only:  sudo /opt/club-ops/deploy.sh --check

# 3) Install compose + Caddyfile + deploy.sh + systemd units (does NOT enable the timer,
#    does NOT overwrite .env, backs up any existing compose):
sudo deploy/install-on-server.sh

# 4) FIRST DEPLOY IS MANUAL (timer stays off until you enable it):
cd /opt/club-ops && sudo ./deploy.sh

# 5) Verify, then enable the auto-deploy timer:
curl -fsS https://<SITE_DOMAIN>/api/health
sudo systemctl enable --now club-ops-deploy.timer
systemctl status club-ops-deploy.timer
```

`deploy.sh --check` validates config without changing anything.

---

## 7. Updates after `git push main`

1. GitHub Actions builds and pushes `:<sha>` and `:main`.
2. Within ~1 minute the timer runs `deploy.sh`, which no-ops unless the `:main`
   **digest** changed, then: backup → migrate → update → health-check.
3. Confirm: `curl -fsS https://<domain>/api/health` shows the new `commit` (= git sha).

Manual trigger any time: `cd /opt/club-ops && sudo ./deploy.sh`.

---

## 8. Operations

**Logs**
```bash
journalctl -u club-ops-deploy.service -n 100 --no-pager   # deploy runs (no secrets)
cd /opt/club-ops && docker compose -f docker-compose.prod.yml logs -f app
docker compose -f docker-compose.prod.yml logs -f caddy
```

**Health**
```bash
docker compose -f /opt/club-ops/docker-compose.prod.yml exec -T app wget -qO- http://127.0.0.1:3000/api/health
curl -fsS https://<SITE_DOMAIN>/api/health     # {commit, environment:"production", storage:"s3", email:"configured"}
```

**Manual rollback** (app only; DB is never auto-rolled-back — migrations are additive/forward-safe)
```bash
cd /opt/club-ops
PREV=$(cat .deployed_image)                    # last good image ref (or pick a :<sha>)
APP_IMAGE="$PREV" docker compose -f docker-compose.prod.yml up -d app caddy
```

**Emergency rollback** (bad image already recorded): set `APP_IMAGE` to a known-good
`cr.yandex/<id>/club-ops:<older-sha>` and run the command above; then pause the timer:
```bash
sudo systemctl stop club-ops-deploy.timer      # stop auto-updates until fixed
```

**Backups**
- Automatic: `deploy.sh` runs `pg_dump -Fc` into `/opt/club-ops/backups/clubops_<ts>.dump` (mode 600) **before** every update; keeps the last 7.
- Manual: `docker exec club-ops-postgres pg_dump -U clubops -d clubops -F c > /opt/club-ops/backups/manual_$(date -u +%FT%TZ).dump`

**Restore a backup into a SEPARATE test DB** (never overwrite production):
```bash
docker exec -i club-ops-postgres createdb -U clubops clubops_restore_test
docker exec -i club-ops-postgres pg_restore -U clubops -d clubops_restore_test < /opt/club-ops/backups/clubops_<ts>.dump
# inspect, then drop:
docker exec -i club-ops-postgres dropdb -U clubops clubops_restore_test
```

**Expand disk**: grow the Yandex boot disk in the console, then on the VM:
```bash
sudo growpart /dev/vda 2 && sudo resize2fs /dev/vda2   # device names may differ; verify with lsblk
```

**Free image space safely** (deploy.sh already keeps the last few; never `prune -a`):
```bash
docker image prune -f                          # dangling only — safe
```

---

## 9. Migration & rollback model

- **Migrations**: a dedicated one-shot `migrate` service runs `prisma migrate deploy --schema=prisma/production/schema.prisma` against the internal DB **before** the app starts. Never `db push`, never `migrate reset`, never seed. On a fresh empty `clubops` DB the full schema is reproduced from `prisma/production/migrations` (`0_init` baseline + subsequent additive migrations).
- **App rollback**: automatic to the previous image if the new app fails `/api/health` within the timeout.
- **DB rollback**: **not** automatic. Migrations are additive/forward-compatible, so rolling the app image back works against the migrated schema. If a real DB rollback is ever needed, restore the pre-deploy `pg_dump` into a test DB first and decide deliberately.

---

## 10. Secrets policy

- Never commit secrets. `.env*` (except `*.example`) is gitignored; the image build excludes `.env`, `uploads`, `backups` (`.dockerignore`).
- Server secrets: only `/opt/club-ops/.env` (mode 600).
- CI secret: only `YC_SA_KEY_JSON` (+ `YC_REGISTRY_ID`) in GitHub Actions; piped via `--password-stdin`, never printed.
- **VM registry auth**: short-lived metadata IAM token only — **no `YC_SA_KEY_JSON`, no static key, no persistent `~/.docker/config.json` on the VM**. Credentials live in a temp `DOCKER_CONFIG` that is deleted on every run.
- `/api/health` exposes only non-sensitive metadata (commit, environment, storage provider name, email status) — never DB/S3/SMTP/OpenAI/session values or cloud project/folder/SA ids.
