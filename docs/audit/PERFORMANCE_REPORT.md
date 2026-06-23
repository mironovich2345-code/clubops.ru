# CLUB-OPS — Performance Report

Honesty note: no live latency numbers were captured in this audit environment (no warmed deployment / production Postgres available). This is a **static query-pattern analysis** with targeted recommendations. Live numbers must be captured on `pilot.clubops.ru` with the instrumentation below before claiming the latency targets are met.

## Observed query patterns (by route)

| Route | Pattern | Risk |
|---|---|---|
| dashboard / analytics | Several scoped aggregates batched via `Promise.all` (sales, expenses, invoices, refunds, budgets, balances). Strategic view does ~3–4 scoped queries per selected Company. | Heaviest route. Scales with #Companies, not #clubs. For 3 clubs / 1 Company = small. Acceptable for pilot; watch multi-Company strategic. |
| expenses / invoices / refunds | One scoped list query + per-page legal-entity lookups (`Promise.all` over clubs). | Bounded by club count (3). Fine. |
| payments / calendar | Obligations loaded per Company via `Promise.all`, then aggregated in app. | Fine at pilot scale. |
| users | Members + invitable roles + per-user session count + manage-authority (`Promise.all` over distinct users). | O(users) extra count queries; pilot user count small. Acceptable. |
| security (own sessions) | One `findMany` of active sessions. | Trivial. |
| auth (every request) | `getValidSession` = 1 indexed `findUnique` by `tokenHash` (+ throttled `lastSeenAt` write ≤ every 10 min). `getCurrentAccessContext` = a few scoped role/company/club lookups. | **No cross-request cache by design** (security). Cost is a handful of indexed queries per request — acceptable; do NOT add an auth/permission/tenant cache. |

## Indexing

Schema has indexes on the hot lookups: `Session.tokenHash` (unique) + `userId`/`expiresAt`/`revokedAt`; `EmailOtpChallenge.challengeTokenHash` (unique) + `userId`/`expiresAt`/`consumedAt`/`revokedAt`; `Company/ClubUserAccess` composite uniques + `userId`/`companyId`; financial tables indexed on `status`, `createdByUserId`, scope FKs. No obviously missing index on a hot path was found.

## Potential bottlenecks (unproven — measure first)

- Strategic multi-Company analytics: linear in #Companies. Today (one pilot Company) it is light; revisit if internal Companies grow.
- `users` page per-user session-count + authority queries: could be folded into fewer queries if user count grows (P3).
- No N+1 over rows was found (legal-entity lookups are `Promise.all`-batched, not per-row sequential).

## Recommended safe instrumentation (to add when measuring)

A request-scoped timing wrapper that:
- stamps a `requestId`, records route/action name + duration + Prisma query count;
- logs structured JSON only (no secrets, no customer data, no document content);
- is gated behind an env flag (e.g. `PERF_TRACE=1`) and **off by default / disabled in production** unless explicitly enabled for a window.

This was NOT added in this task (avoid unproven changes); it is the recommended first step of a dedicated performance pass.

## Targets (to validate on the warmed pilot)

- Common pages ≈ 1–2 s or better.
- Heavy analytics ≈ 3 s or better.
- Immediate visible loading feedback (App Router `loading.tsx` / skeletons — verify presence on heavy routes).

## Verdict

No proven bottleneck blocks the pilot at three-club scale. **Do not optimize blindly.** Capture live numbers with the gated instrumentation, then fix only what the data shows. Explicitly: do not introduce global caches for authentication, permissions or tenant data.
