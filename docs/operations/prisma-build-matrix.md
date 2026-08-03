# CLUB-OPS — Prisma Build/Client Matrix (ARCH-013)

Read-only analysis at `dc14d10`. Root cause of ARCH-013 is precisely located.

## Root cause: one un-pathed generator slot
Both schemas declare `generator client { provider = "prisma-client-js" }` with **no `output`**:
`prisma/schema.prisma:1-3` (sqlite) and `prisma/production/schema.prisma:5-7` (postgres). Grep for
`output =` across `prisma/` → **zero**. So both generate into the **same** default slot
`node_modules/.prisma/client`. The datasource `provider` is baked into that client → **dev (sqlite)
and prod (postgres) clients cannot coexist; the last `prisma generate` wins and overwrites the other.**
The client is **not** committed (`.gitignore` ignores `node_modules/`; no `.prisma`/generated entry) —
it is always regenerated, so "which client is live" is decided by whichever generate ran **last**,
unenforced.

## Command → provider left in `node_modules/.prisma/client`
| Command (package.json) | Schema | Provider left |
|---|---|---|
| `postinstall` / `prisma:generate` = `prisma generate` | dev | **sqlite** |
| `prisma:generate:prod` = `prisma generate --schema=prisma/production/schema.prisma` | prod | **postgresql** |
| `build:prod` = `prisma generate --schema=prisma/production/schema.prisma && next build` | prod | **postgresql** (bundled into the build) |
| `prisma:migrate` = `prisma migrate dev` | dev | **sqlite** |

## The four sequences (§3)
| # | Sequence | Provider after | Effect |
|---|---|---|---|
| A | generate dev → pilot:full → **build:prod** → pilot:full | postgres | second `pilot:full` **breaks** (34 DB-backed suites can't open the sqlite `file:` URL) until a dev generate |
| B | generate prod → build:prod → start | postgres | correct for **production** start (postgres client + DATABASE_URL) |
| C | build failure mid-`next build` | postgres (generate already ran) | dev client already clobbered; dev pilots broken |
| D | switch back: generate dev | sqlite | restores dev; **but** if this runs on a deploy host, a production process could boot a **sqlite** client against DATABASE_URL |

## Confirmed facts (ARCH-013)
1. **Single shared slot, mutually overwriting** — no per-schema `output`.
2. **No restore wrapper** — `build:prod` is a bare `&&` chain; no `postbuild` regenerates the dev client (`package.json` scripts have none).
3. **DB-backed pilots break after build:prod** — postgres client rejects `file:./dev.db`; restored only by chance (next `npm install`/`prisma:generate`/`prisma:migrate`).
4. **Reverse hazard** — a stray dev generate (e.g. `npm install` postinstall) on a deploy host leaves production running a **sqlite** client against a postgres URL (fails at connect).
5. **Green build ≠ prod-ready** — the build succeeds regardless; the client-provider correctness is order-dependent and unverified.

## Risk classification (no fix applied)
- **Local/CI dev workflow:** MEDIUM — silent false pilot failures after a build; the audit pilots and this program always `prisma generate --schema=prisma/schema.prisma` afterward to compensate.
- **Production start:** LOW-in-practice — the image is built with `build:prod` (postgres) and started without a further dev generate, so the shipped client is postgres. The hazard is a manual/postinstall dev generate on the host.
- **Recommended remediation (deferred, OPS):** give each schema a distinct `output` path (coexisting clients), or add a `postbuild` that regenerates the dev client for local/CI, and assert the client provider at container start. **Not changed in this audit.**
