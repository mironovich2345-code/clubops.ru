#!/usr/bin/env bash
# Install/refresh the CLUB-OPS deploy files on the production VM. Idempotent.
# Run from a checkout of the repo on the server, as a user with sudo:
#
#   sudo deploy/install-on-server.sh                 # install files + config check
#   sudo deploy/install-on-server.sh --enable-timer  # ... and enable the auto-deploy timer
#
# It NEVER touches /opt/club-ops/.env (secrets) and NEVER removes the postgres
# volume. The existing compose file is timestamp-backed-up before replacement.
set -Eeuo pipefail

DEPLOY_DIR="/opt/club-ops"
SYSTEMD_DIR="/etc/systemd/system"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
ENABLE_TIMER=0
[ "${1:-}" = "--enable-timer" ] && ENABLE_TIMER=1

log() { echo "[install] $*"; }
die() { echo "[install] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo/root"

# --- required system dependencies (checked, never auto-installed) ------------
# deploy.sh needs: docker + compose, curl + python3 (metadata IAM token), flock
# (single-flight). pg_dump runs INSIDE the postgres container, so it is not a host
# dependency. openssl is only suggested in docs for generating secrets by hand.
missing=""
command -v docker  >/dev/null 2>&1 || missing="${missing} docker.io"
command -v curl    >/dev/null 2>&1 || missing="${missing} curl"
command -v python3 >/dev/null 2>&1 || missing="${missing} python3"
command -v flock   >/dev/null 2>&1 || missing="${missing} util-linux"
if ! docker compose version >/dev/null 2>&1; then missing="${missing} docker-compose-plugin"; fi
if [ -n "$missing" ]; then
  die "missing system dependencies:${missing}
     install them first, e.g.:  sudo apt-get update && sudo apt-get install -y${missing}
     (deploy.sh will not run without curl + python3 for the metadata IAM token.)"
fi
log "system dependencies present: docker, docker compose, curl, python3, flock"

log "ensuring ${DEPLOY_DIR} exists ..."
mkdir -p "$DEPLOY_DIR" "$DEPLOY_DIR/backups"
chmod 750 "$DEPLOY_DIR"; chmod 700 "$DEPLOY_DIR/backups"

# Back up an existing compose before overwriting (never lose the current one).
if [ -f "${DEPLOY_DIR}/docker-compose.prod.yml" ]; then
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a "${DEPLOY_DIR}/docker-compose.prod.yml" "${DEPLOY_DIR}/docker-compose.prod.yml.bak.${ts}"
  log "backed up existing compose -> docker-compose.prod.yml.bak.${ts}"
fi

install_file() {  # src dst mode
  install -m "$3" "$1" "$2"
  log "installed $(basename "$2") (mode $3)"
}

install_file "${SRC_DIR}/docker-compose.prod.yml" "${DEPLOY_DIR}/docker-compose.prod.yml" 0640
install_file "${SRC_DIR}/Caddyfile"               "${DEPLOY_DIR}/Caddyfile"               0640
install_file "${SRC_DIR}/deploy.sh"               "${DEPLOY_DIR}/deploy.sh"               0750
install_file "${SRC_DIR}/systemd/club-ops-deploy.service" "${SYSTEMD_DIR}/club-ops-deploy.service" 0644
install_file "${SRC_DIR}/systemd/club-ops-deploy.timer"   "${SYSTEMD_DIR}/club-ops-deploy.timer"   0644

# Preserve .env — create a template ONLY if truly absent (never overwrite).
if [ ! -f "${DEPLOY_DIR}/.env" ]; then
  log "NOTE: ${DEPLOY_DIR}/.env is missing — create it (see docs/YANDEX_DEPLOYMENT.md) before deploying."
else
  chmod 600 "${DEPLOY_DIR}/.env" || true
  log ".env already present — left untouched"
fi

log "reloading systemd ..."
systemctl daemon-reload

if [ "$ENABLE_TIMER" = "1" ]; then
  systemctl enable --now club-ops-deploy.timer
  log "auto-deploy timer ENABLED (checks every minute)."
else
  log "auto-deploy timer NOT enabled (default). Enable it AFTER the first manual deploy:"
  log "    sudo systemctl enable --now club-ops-deploy.timer"
fi

# Non-destructive config validation (does not deploy).
if [ -f "${DEPLOY_DIR}/.env" ]; then
  log "running deploy.sh --check ..."
  ( cd "$DEPLOY_DIR" && ./deploy.sh --check ) || log "config check reported issues (fix .env / infra, then re-run)"
fi

log "done. First deploy is MANUAL:  cd ${DEPLOY_DIR} && sudo ./deploy.sh"
