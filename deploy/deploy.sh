#!/usr/bin/env bash
# CLUB-OPS safe production deploy (Yandex Cloud VM).
#
# Flow: single-flight lock -> preflight -> (digest gate) -> pg_dump backup ->
#       pull image -> migrate (one-shot) -> recreate app+caddy -> health ->
#       on failure roll the APP back to the previous image (DB is NOT rolled back).
#
# Never prints secrets, DATABASE_URL, passwords or document contents. Never
# deletes the postgres volume and never runs `docker system prune -a`.
#
#   deploy.sh            # perform a deploy if the :main image digest changed
#   deploy.sh --check    # validate configuration only; change nothing
set -Eeuo pipefail

DEPLOY_DIR="/opt/club-ops"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.prod.yml"
ENV_FILE="${DEPLOY_DIR}/.env"
BACKUP_DIR="${DEPLOY_DIR}/backups"
STATE_FILE="${DEPLOY_DIR}/.deployed_image"
LOCK_FILE="${DEPLOY_DIR}/.deploy.lock"
NETWORK="club_ops_internal"
VOLUME="club_ops_postgres_data"
PG_CONTAINER="club-ops-postgres"
MAIN_TAG="main"
KEEP_BACKUPS=7
KEEP_IMAGES=5
HEALTH_TIMEOUT=120
MIN_FREE_KB=2000000   # ~2 GB

log()  { echo "[deploy $(date -u +%FT%TZ)] $*"; }
die()  { log "ERROR: $*"; exit 1; }
trap 'die "unexpected failure on line ${LINENO}"' ERR

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# Read ONE non-secret key from .env without sourcing the file or printing values.
env_get() { grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//'; }

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# --- single-flight lock ------------------------------------------------------
exec 9>"$LOCK_FILE" 2>/dev/null || die "cannot open lock file (need write to ${DEPLOY_DIR})"
if ! flock -n 9; then log "another deploy is in progress — exiting"; exit 0; fi

cd "$DEPLOY_DIR" || die "cannot cd to ${DEPLOY_DIR}"

# --- preflight ---------------------------------------------------------------
[ -f "$ENV_FILE" ]      || die ".env not found at ${ENV_FILE}"
[ -f "$COMPOSE_FILE" ]  || die "compose file not found at ${COMPOSE_FILE}"
command -v docker >/dev/null 2>&1 || die "docker not installed"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not available"
docker network inspect "$NETWORK" >/dev/null 2>&1 || die "docker network '${NETWORK}' missing"
docker volume  inspect "$VOLUME"  >/dev/null 2>&1 || die "docker volume '${VOLUME}' missing"

APP_IMAGE_REPO="$(env_get APP_IMAGE_REPO)"
[ -n "$APP_IMAGE_REPO" ] || die "APP_IMAGE_REPO not set in .env (e.g. cr.yandex/<registry-id>/club-ops)"
MAIN_IMAGE="${APP_IMAGE_REPO}:${MAIN_TAG}"

AVAIL_KB="$(df -Pk "$DEPLOY_DIR" | awk 'NR==2{print $4}')"
[ "${AVAIL_KB:-0}" -ge "$MIN_FREE_KB" ] || die "insufficient free disk space (<2GB) on ${DEPLOY_DIR}"

if [ "$CHECK_ONLY" = "1" ]; then
  compose config >/dev/null || die "compose config invalid"
  log "check OK: env, docker, compose, network '${NETWORK}', volume '${VOLUME}', APP_IMAGE_REPO present, disk ok"
  exit 0
fi

# --- digest gate: only deploy when the :main image content changed -----------
log "pulling ${MAIN_IMAGE} ..."
docker pull "$MAIN_IMAGE" >/dev/null || die "docker pull failed"
NEW_IMAGE="$(docker image inspect "$MAIN_IMAGE" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}')"
[ -n "$NEW_IMAGE" ] || die "could not resolve pulled image digest"
PREV_IMAGE="$(cat "$STATE_FILE" 2>/dev/null || true)"

if [ -n "$PREV_IMAGE" ] && [ "$NEW_IMAGE" = "$PREV_IMAGE" ]; then
  log "image digest unchanged — nothing to deploy"
  exit 0
fi
log "new image detected (deploying)"

# --- database backup (custom format) BEFORE any change -----------------------
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
POSTGRES_DB="$(env_get POSTGRES_DB)"; POSTGRES_USER="$(env_get POSTGRES_USER)"
[ -n "$POSTGRES_DB" ] && [ -n "$POSTGRES_USER" ] || die "POSTGRES_DB/POSTGRES_USER missing in .env"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${BACKUP_DIR}/clubops_${TS}.dump"
log "creating database backup (pg_dump -Fc) ..."
if ! docker exec "$PG_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c > "$BACKUP_FILE" 2>/dev/null; then
  rm -f "$BACKUP_FILE"
  die "database backup failed — aborting deploy (no changes made)"
fi
chmod 600 "$BACKUP_FILE"
[ -s "$BACKUP_FILE" ] || { rm -f "$BACKUP_FILE"; die "backup file is empty — aborting deploy"; }
log "backup written: $(basename "$BACKUP_FILE") ($(du -h "$BACKUP_FILE" | cut -f1))"
# Keep only the most recent N backups.
ls -1t "${BACKUP_DIR}"/clubops_*.dump 2>/dev/null | tail -n +"$((KEEP_BACKUPS+1))" | xargs -r rm -f

# --- apply: migrate (one-shot), then recreate app + caddy --------------------
export APP_IMAGE="$NEW_IMAGE"
export APP_DEPLOYMENT_ID="$NEW_IMAGE"

log "running database migrations (prisma migrate deploy) ..."
if ! compose run --rm migrate; then
  die "migration failed — app NOT updated; DB unchanged beyond any applied migration; restore from ${BACKUP_FILE} if needed"
fi

log "starting postgres + app + caddy on the new image ..."
compose up -d postgres app caddy

# --- health check (inside the docker network) --------------------------------
healthy=0
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
  if compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done

if [ "$healthy" = "1" ]; then
  # Optional external check when a domain is configured (best-effort, non-fatal).
  SITE_DOMAIN="$(env_get SITE_DOMAIN)"
  if [ -n "$SITE_DOMAIN" ]; then
    if curl -fsS --max-time 10 "https://${SITE_DOMAIN}/api/health" >/dev/null 2>&1; then
      log "external HTTPS health OK (https://${SITE_DOMAIN}/api/health)"
    else
      log "note: external HTTPS health not reachable yet (DNS/cert may still be provisioning)"
    fi
  fi
  echo "$NEW_IMAGE" > "$STATE_FILE"; chmod 600 "$STATE_FILE"
  log "deploy OK — app healthy on new image"
  # Prune old app images safely (keep the most recent N of this repo; never -a).
  docker images "${APP_IMAGE_REPO}" --format '{{.ID}} {{.CreatedAt}}' \
    | sort -k2 -r | awk 'NR>'"$KEEP_IMAGES"'{print $1}' | xargs -r docker rmi >/dev/null 2>&1 || true
  compose ps
  exit 0
fi

# --- rollback (app only; DB migration is intentionally NOT rolled back) -------
log "new app did NOT become healthy within ${HEALTH_TIMEOUT}s"
if [ -n "$PREV_IMAGE" ]; then
  log "rolling app back to previous image ..."
  export APP_IMAGE="$PREV_IMAGE"
  export APP_DEPLOYMENT_ID="$PREV_IMAGE"
  compose up -d app caddy || log "rollback command reported an error"
  log "rolled back to previous image (DB left as-is; backup at ${BACKUP_FILE})"
else
  log "no previous image recorded — cannot roll back automatically (first deploy)"
fi
compose ps || true
die "deploy failed — health check did not pass"
