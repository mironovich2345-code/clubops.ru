#!/bin/sh
# Single-container startup (Railway / plain `docker run`): apply DB migrations,
# then start the standalone Next.js server. Uses `exec` so Next.js becomes PID 1
# for clean signal handling. The Prisma CLI is invoked directly (standalone does
# not include npm scripts). On the VM this entrypoint is NOT used — the compose
# file runs a dedicated migrate service and `node server.js` for the app.
set -e

echo "[entrypoint] Applying database migrations (prisma migrate deploy)..."
node node_modules/prisma/build/index.js migrate deploy --schema=prisma/production/schema.prisma

echo "[entrypoint] Starting Next.js (standalone) on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}..."
exec node server.js
