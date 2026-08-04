# REM-07 — Request Context & Correlation Design

## Request id (spec §3/§4)
- **Server-minted** in `src/middleware.ts` — `crypto.randomUUID()` (Edge Web Crypto), set on the request
  header `x-request-id` (so RSC / server actions read it) AND the response header `X-Request-Id`.
- An **inbound client `X-Request-Id` is never trusted** — the middleware overwrites it, so a forged
  correlation id / log-injection value cannot enter. A trusted-proxy trace id (if ever adopted post
  SEC-002) would be stored SEPARATELY, never reused as this id.
- Never a session token or entity id. Bounded to ≤64 chars when read back.

## Reading it (`src/lib/security/request-context.ts`)
- `getRequestId()` — reads `x-request-id` via `next/headers`; returns `null` off-request (background job)
  without throwing.
- `buildSecurityContext(opts)` → `{ requestId, timestamp, actorId, companyId, role, route, source,
  deploymentVersion }` — every field safe to log; no tokens/PII/full-IP.

## Trusted proxy contract (spec §4, links SEC-002)
- Caddy/Railway front the app. REM-07 does NOT declare `X-Forwarded-For` trusted — IP/UA policy stays
  "untrusted signal" until SEC-002. Correlation relies on the internally-minted id only.

## Response / server-action surface
- API/page responses carry `X-Request-Id`.
- Server actions have no direct response header; the id is available via the request context and is
  returned to the user inside the safe denial message (`deniedUserMessage`) so support can trace it —
  without exposing the reason or tenant.
