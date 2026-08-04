# syntax=docker/dockerfile:1
# Production image for the CLUB-OPS Next.js app (RU / self-hosted + Railway).
#
# Standalone Next.js output ( .next/standalone/server.js ) is used for a small,
# self-contained runtime. The Prisma CLI + engines are copied into the runner so
# the SAME image can run `prisma migrate deploy` (as a separate compose service
# on the VM, or inline for Railway's single-container flow via the entrypoint).
#
# Security: the SHIPPED `runner` stage applies the latest Debian Bookworm
# security updates (`apt-get upgrade`) on every production build, busted by the
# non-secret APT_REFRESH build arg. Node 20 + Bookworm are kept intentionally.
# NO secrets are ever baked in. Non-secret build args only: APP_GIT_SHA, APT_REFRESH.

# --- build base: Node 20 (Bookworm) + minimal libs for the BUILD -------------
# openssl (libssl3) + ca-certificates are needed by `prisma generate`. wget/curl
# are NOT installed — the runtime healthcheck uses Node's http module.
FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
# NOTE: NODE_ENV is intentionally NOT "production" in the build stages — that
# would make `npm ci` omit devDependencies (typescript/tailwindcss/postcss/
# autoprefixer) that `next build` needs. It is set only in the runner stage.

# --- deps: install all deps (postinstall runs `prisma generate`) -------------
FROM base AS deps
COPY package.json package-lock.json ./
# prisma/ is needed so the postinstall `prisma generate` can read the schema.
COPY prisma ./prisma
RUN npm ci

# --- builder: generate PostgreSQL client + standalone Next.js build ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Non-secret build metadata only (defaults to "local" for plain `docker build`).
ARG APP_GIT_SHA=local
ENV APP_GIT_SHA=$APP_GIT_SHA
# Generates the PostgreSQL Prisma client and the standalone Next.js server.
RUN npm run build:prod

# --- runner: minimal, security-patched standalone runtime --------------------
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
# Standalone server binds to HOSTNAME:PORT — 0.0.0.0 so the container is reachable.
ENV HOSTNAME=0.0.0.0
# Non-secret deployment metadata baked into the image (surfaced by /api/health).
ARG APP_GIT_SHA=local
ENV APP_GIT_SHA=$APP_GIT_SHA

# Apply the latest Bookworm SECURITY updates in the shipped image. APT_REFRESH is
# a non-secret, per-build value (commit SHA / run id) whose only purpose is to
# invalidate this layer every production build so `apt-get update && upgrade`
# never serves stale package lists from the Docker/BuildKit cache.
ARG APT_REFRESH=none
# poppler-utils provides `pdftoppm`, used to render the first page of a scanned
# PDF invoice to a PNG in memory (piped via stdin→stdout, nothing on disk) so it
# can be OCR'd as an image. GUI-less; no extra runtime services. See
# src/lib/ai/pdf-render.ts and docs/CONTAINER_SECURITY.md.
RUN echo "APT refresh: ${APT_REFRESH}" >/dev/null \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates poppler-utils \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Run as a non-root user.
RUN useradd --uid 1001 --create-home --shell /usr/sbin/nologin nodejs

# Standalone server + the assets standalone does NOT bundle (static + public).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Prisma schema + migrations for `prisma migrate deploy`.
COPY --from=builder /app/prisma ./prisma
# Prisma CLI + engines (NOT traced into standalone) so the migrate step works
# from this same image. The generated client (.prisma) is already in standalone;
# copied again from the builder to guarantee the correct Linux query engine.
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# uploads/ is used only when STORAGE_PROVIDER=local; production uses S3. The dir
# is writable by the app user; everything else can run from read-only source.
RUN mkdir -p /app/uploads && chown -R nodejs:nodejs /app/uploads
USER nodejs
EXPOSE 3000
# Healthcheck uses the Node runtime (no wget/curl dependency, no shell injection).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||3000;require('http').get('http://127.0.0.1:'+p+'/api/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

# Default CMD = migrate then start (single-container / Railway). On the VM the
# compose file overrides this: a dedicated `migrate` service runs the migration
# and the `app` service runs `node server.js` only.
CMD ["sh", "/app/docker-entrypoint.sh"]
