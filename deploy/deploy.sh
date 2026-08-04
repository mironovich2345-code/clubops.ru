#!/usr/bin/env bash
# CLUB-OPS safe production deploy (Yandex Cloud VM).
#
# Flow: single-flight lock -> preflight -> registry auth (short-lived IAM token
#       from the VM metadata service, in a temp DOCKER_CONFIG) -> remote digest
#       gate -> pg_dump backup -> pull image -> migrate (one-shot) -> recreate
#       app+caddy -> health -> on failure roll the APP back to the previous image
#       (DB is NOT rolled back). The temp DOCKER_CONFIG is ALWAYS removed.
#
# Registry auth uses the VM's attached service account (role
# container-registry.images.puller) — NO static key / JSON key is ever stored on
# the VM, and credentials are never written to a persistent ~/.docker/config.json.
#
# Never prints secrets, IAM tokens, DATABASE_URL, passwords or document contents.
# Never deletes the postgres volume and never runs `docker system prune -a`.
#
#   deploy.sh            # perform a deploy if the :main image digest changed
#   deploy.sh --check    # validate config + registry auth only; change nothing
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
REGISTRY="cr.yandex"
METADATA_TOKEN_URL="http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token"
MAIN_TAG="main"
KEEP_BACKUPS=7
KEEP_IMAGES=5
HEALTH_TIMEOUT=120
MIN_FREE_KB=2000000   # ~2 GB

DOCKER_CONFIG_DIR=""   # temp dir; created lazily, always removed by cleanup

log()  { echo "[deploy $(date -u +%FT%TZ)] $*"; }
die()  { log "ERROR: $*"; exit 1; }

# Best-effort teardown on ANY exit / signal: logout, remove the temp docker
# config, and scrub token vars. Never masks the original exit code, never fails.
cleanup() {
  local rc=$?
  if [ -n "${DOCKER_CONFIG:-}" ]; then
    docker logout "$REGISTRY" >/dev/null 2>&1 || true
  fi
  [ -n "${DOCKER_CONFIG_DIR:-}" ] && rm -rf "$DOCKER_CONFIG_DIR" 2>/dev/null || true
  unset IAM_TOKEN DOCKER_CONFIG DOCKER_CONFIG_DIR 2>/dev/null || true
  return "$rc"
}
trap 'die "unexpected failure (line ${LINENO})"' ERR
trap cleanup EXIT
trap 'log "interrupted by signal"; exit 130' INT TERM

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# Read ONE non-secret key from .env without sourcing the file or printing values.
env_get() { grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//'; }

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# Create an isolated, private DOCKER_CONFIG for this run (never $HOME/.docker).
setup_docker_config() {
  umask 077
  DOCKER_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/club-ops-docker.XXXXXX")" || die "cannot create temp docker config dir"
  chmod 700 "$DOCKER_CONFIG_DIR"
  export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"
}

# Fetch a fresh short-lived IAM token from the VM metadata service and docker
# login to the registry. The token is passed via stdin only (never as an arg),
# never logged, and dropped immediately after login. Requires curl + python3.
registry_login() {
  local resp token
  resp="$(curl -s --fail --connect-timeout 3 --max-time 8 --retry 3 --retry-delay 1 \
    -H 'Metadata-Flavor: Google' "$METADATA_TOKEN_URL" 2>/dev/null)" \
    || die "metadata service unreachable — cannot obtain IAM token (is service account 'club-ops-vm' attached with the puller role?)"

  # Parse the JSON safely with python3; validate access_token + expires_in.
  token="$(printf '%s' "$resp" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)
t = d.get("access_token", "")
if not t:
    sys.exit(3)
e = d.get("expires_in")  # optional; if present must be a number
if e is not None:
    try:
        int(e)
    except Exception:
        sys.exit(4)
sys.stdout.write(t)
' 2>/dev/null)" || die "metadata token response was not valid JSON / had no access_token"
  unset resp
  [ -n "$token" ] || die "metadata service returned an empty access_token"

  IAM_TOKEN="$token"; unset token
  if ! printf '%s' "$IAM_TOKEN" | docker login --username iam --password-stdin "$REGISTRY" >/dev/null 2>&1; then
    unset IAM_TOKEN
    die "docker login to ${REGISTRY} failed (IAM token rejected or puller role missing)"
  fi
  unset IAM_TOKEN   # minimal lifetime; cleanup() unsets again defensively
  log "authenticated to ${REGISTRY} via VM service account (short-lived token, temp config)"
}

# Resolve the REMOTE manifest digest of :main WITHOUT pulling layers. Uses the
# temp DOCKER_CONFIG (exported). buildx imagetools first, manifest inspect fallback.
remote_digest() {
  local d=""
  if docker buildx version >/dev/null 2>&1; then
    d="$(docker buildx imagetools inspect "$MAIN_IMAGE" --format '{{.Manifest.Digest}}' 2>/dev/null || true)"
  fi
  if [ -z "$d" ]; then
    d="$(DOCKER_CLI_EXPERIMENTAL=enabled docker manifest inspect --verbose "$MAIN_IMAGE" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if isinstance(d, list):
    d = d[0] if d else {}
print(d.get("Descriptor", {}).get("digest", ""))
' 2>/dev/null || true)"
  fi
  printf '%s' "$d"
}

# --- single-flight lock ------------------------------------------------------
exec 9>"$LOCK_FILE" 2>/dev/null || die "cannot open lock file (need write to ${DEPLOY_DIR})"
if ! flock -n 9; then log "another deploy is in progress — exiting"; exit 0; fi

cd "$DEPLOY_DIR" || die "cannot cd to ${DEPLOY_DIR}"

# --- preflight ---------------------------------------------------------------
[ -f "$ENV_FILE" ]      || die ".env not found at ${ENV_FILE}"
[ -f "$COMPOSE_FILE" ]  || die "compose file not found at ${COMPOSE_FILE}"
command -v docker  >/dev/null 2>&1 || die "docker not installed"
command -v curl    >/dev/null 2>&1 || die "curl not installed"
command -v python3 >/dev/null 2>&1 || die "python3 not installed"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not available"
docker network inspect "$NETWORK" >/dev/null 2>&1 || die "docker network '${NETWORK}' missing"
docker volume  inspect "$VOLUME"  >/dev/null 2>&1 || die "docker volume '${VOLUME}' missing"

APP_IMAGE_REPO="$(env_get APP_IMAGE_REPO)"
[ -n "$APP_IMAGE_REPO" ] || die "APP_IMAGE_REPO not set in .env (e.g. cr.yandex/<registry-id>/club-ops)"
MAIN_IMAGE="${APP_IMAGE_REPO}:${MAIN_TAG}"

AVAIL_KB="$(df -Pk "$DEPLOY_DIR" | awk 'NR==2{print $4}')"
[ "${AVAIL_KB:-0}" -ge "$MIN_FREE_KB" ] || die "insufficient free disk space (<2GB) on ${DEPLOY_DIR}"

# --- registry auth (temp config; BEFORE any private-registry access) ---------
setup_docker_config
registry_login

if [ "$CHECK_ONLY" = "1" ]; then
  # --check only VALIDATES compose syntax — it never pulls/migrates/backs up/starts
  # anything and never writes STATE_FILE. `docker compose config` still needs the
  # ${APP_IMAGE}/${APP_DEPLOYMENT_ID} placeholders substituted, so pass throwaway
  # values scoped to THIS one command only (not exported, never persisted, never
  # added to .env). The :main tag is used here purely for static validation; the
  # real deploy always pins an immutable digest (see the digest gate below).
  APP_IMAGE="$MAIN_IMAGE" APP_DEPLOYMENT_ID="preflight-check" \
    compose config >/dev/null || die "compose config invalid"
  # Confirm credentials landed ONLY in the temp config, never in a persistent one.
  [ "${DOCKER_CONFIG:-}" = "$DOCKER_CONFIG_DIR" ] || die "DOCKER_CONFIG is not the temp dir"
  for cfg in /root/.docker/config.json "$HOME/.docker/config.json"; do
    if [ -f "$cfg" ] && grep -q "$REGISTRY" "$cfg" 2>/dev/null; then
      die "persistent registry credentials found in ${cfg} — remove them (VM must use the metadata token only)"
    fi
  done
  log "check OK: env, docker, curl, python3, compose, network '${NETWORK}', volume '${VOLUME}', disk ok, registry auth via metadata service works (temp config), no persistent credentials"
  exit 0   # cleanup() removes the temp DOCKER_CONFIG
fi

# --- digest gate: only deploy when the remote :main digest changed -----------
REMOTE_DIGEST="$(remote_digest)"
[ -n "$REMOTE_DIGEST" ] || die "could not resolve remote digest for ${MAIN_IMAGE} (registry auth or buildx/manifest issue)"
NEW_IMAGE="${APP_IMAGE_REPO}@${REMOTE_DIGEST}"
PREV_IMAGE="$(cat "$STATE_FILE" 2>/dev/null || true)"

if [ -n "$PREV_IMAGE" ] && [ "$NEW_IMAGE" = "$PREV_IMAGE" ]; then
  log "remote image digest unchanged — nothing to deploy"
  exit 0   # cleanup() still removes the temp DOCKER_CONFIG
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
# Keep only the most recent N backups (this LOCAL copy is a fast secondary, never the only copy).
ls -1t "${BACKUP_DIR}"/clubops_*.dump 2>/dev/null | tail -n +"$((KEEP_BACKUPS+1))" | xargs -r rm -f

# --- REM-03: OFF-SITE pre-deploy backup (verified) — abort deploy on failure -----------------
# The local dump above shares the VM's failure domain (OPS-001). If off-site is configured
# (BACKUP_S3_BUCKET set in .env), also create + verify an off-site copy BEFORE migrating; a failed
# off-site backup aborts the deploy (DB unchanged). If not configured, warn loudly and continue on the
# local-only copy (a beta escape hatch — production MUST configure BACKUP_S3_*).
if [ -n "$(env_get BACKUP_S3_BUCKET)" ]; then
  log "creating verified OFF-SITE pre-deploy backup ..."
  if ! docker compose -f "$COMPOSE_FILE" run --rm -e "BACKUP_ALLOW_LOCALHOST=false" app node scripts/backup-database.mjs --type=pre-deploy --json >/dev/null 2>&1; then
    die "off-site pre-deploy backup FAILED — aborting deploy (DB unchanged; local backup at ${BACKUP_FILE})"
  fi
  log "off-site pre-deploy backup verified"
else
  log "WARNING: BACKUP_S3_BUCKET not set — NO off-site backup (local-only). Configure BACKUP_S3_* before production (OPS-001)."
fi

# --- pull the exact digest (refresh the token right before pull) -------------
registry_login   # re-auth so a long backup cannot expire the login before pull
log "pulling ${NEW_IMAGE} ..."
docker pull "$NEW_IMAGE" >/dev/null || die "docker pull failed"

# --- apply: migrate (one-shot), then recreate app + caddy --------------------
export APP_IMAGE="$NEW_IMAGE"
export APP_DEPLOYMENT_ID="$NEW_IMAGE"

log "running database migrations (prisma migrate deploy) ..."
if ! compose run --rm migrate; then
  die "migration failed — app NOT updated; DB unchanged beyond any applied migration; restore from ${BACKUP_FILE} if needed"
fi

log "starting postgres + app + caddy on the new image ..."
compose up -d postgres app caddy

# --- health check (inside the docker network; Node probe, no wget in image) --
HEALTH_JS="require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
healthy=0
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
  if compose exec -T app node -e "$HEALTH_JS" >/dev/null 2>&1; then healthy=1; break; fi
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
