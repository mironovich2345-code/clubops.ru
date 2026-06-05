#!/bin/sh
# Container startup: apply DB migrations, then start Next.js.
# Sequential statements (no `&&` that could be split when a start command is run
# without a shell) and `exec` so Next.js becomes the main process (clean signals).
set -e

echo "[entrypoint] Applying database migrations (prisma migrate deploy)..."
npm run prisma:migrate:deploy

echo "[entrypoint] Starting Next.js on 0.0.0.0:${PORT:-3000}..."
exec npm run start -- -p "${PORT:-3000}" -H 0.0.0.0
