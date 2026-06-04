# syntax=docker/dockerfile:1
# Production image for the CLUB-OPS Next.js app (RU / self-hosted deployment).
# Mirrors the Railway flow: build:prod (Postgres Prisma client + next build),
# then on start: prisma migrate deploy -> next start.

FROM node:20-bookworm-slim AS base
ENV NODE_ENV=production
WORKDIR /app
# OpenSSL is required by Prisma engines; wget is used by the healthcheck.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

# --- deps: install all deps (postinstall runs `prisma generate`) -------------
FROM base AS deps
COPY package.json package-lock.json ./
# prisma/ is needed so the postinstall `prisma generate` can read the schema.
COPY prisma ./prisma
RUN npm ci

# --- builder: generate Postgres client + build Next.js -----------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generates the PostgreSQL Prisma client and builds the app.
RUN npm run build:prod

# --- runner: minimal runtime image -------------------------------------------
FROM base AS runner
ENV PORT=3000
# Run as a non-root user.
RUN useradd --uid 1001 --create-home --shell /usr/sbin/nologin nodejs
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
# uploads/ is only used when STORAGE_PROVIDER=local; mount a volume in prod.
RUN mkdir -p /app/uploads && chown -R nodejs:nodejs /app/uploads
USER nodejs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null 2>&1 || exit 1
# Apply DB migrations, then start the server. PORT is provided by the platform.
CMD ["sh", "-c", "npm run prisma:migrate:deploy && npm run start -- -p ${PORT:-3000} -H 0.0.0.0"]
