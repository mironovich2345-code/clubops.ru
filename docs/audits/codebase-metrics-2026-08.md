# CLUB-OPS — Codebase Metrics (2026-08)

Read-only static scan at commit `71f1cff`. Regenerate with `npm run audit:codebase-metrics`
(machine-readable JSON at `docs/audits/data/codebase-metrics.json`). Quantity is context, not a
quality verdict — the risks live in the audit findings, not the line counts.

## Size
| Metric | Value |
|---|---|
| TS/TSX files | 481 |
| Total LOC (ts+tsx) | 71,860 |
| …of which .tsx | 28,346 |
| Prisma models | 82 |
| Prisma enums | 0 (statuses = string constants) |
| Migrations (dev / prod) | 75 / 72 — **drift 3** |
| Pilot suites | 80 (79 + runner) |
| `check()` assertions (approx) | 3,589 |
| Server actions | ~263 in 59 `"use server"` files |
| API route handlers | 17 |
| `"use client"` files | 112 |

## Complexity / hotspots
| Metric | Value |
|---|---|
| Files > 500 LOC | 17 |
| Functions > 100 LOC | 55 |
| Biggest file | `src/app/(app)/invoices/actions.ts` — 1,490 |
| Biggest single function | `buildAnalyticsReport` (`src/lib/analytics.ts`) — ~274 lines |

### Files > 500 LOC (top 17)
| LOC | File |
|---|---|
| 1490 | src/app/(app)/invoices/actions.ts |
| 969 | src/app/(app)/payroll/periods/actions.ts |
| 795 | src/app/(app)/analytics/page.tsx |
| 788 | src/lib/analytics.ts |
| 767 | src/app/(app)/settings/integrations/ofd/actions.ts |
| 738 | src/app/(app)/refunds/refund-document-actions.ts |
| 730 | src/app/(app)/users/actions.ts |
| 693 | src/lib/access.ts |
| 684 | src/app/(app)/payments/page.tsx |
| 635 | src/app/(app)/payroll/change-requests/actions.ts |
| 605 | src/lib/invoices.ts |
| 534 | src/app/(app)/settings/integrations/ofd/_components/OfdForms.tsx |
| 531 | src/app/(app)/expenses/actions.ts |
| 523 | src/lib/activity.ts |
| 511 | src/app/(app)/expenses/page.tsx |
| 510 | src/app/(app)/collections/actions.ts |
| 509 | src/lib/payment-obligations.ts |

## Data-access shape (`npm run audit:direct-prisma-access` / `audit:tenant-query-patterns`)
| Metric | Value |
|---|---|
| Files touching `prisma` | 160 (lib 73, server-action 46, page-rsc 35, api-route 4, component 3) |
| Prisma calls inside page.tsx / components | 38 (35 pages + 3 components) |
| `findUnique({where:{id}})` | 178 |
| `.update({where:{id...}})` | 161 |
| `.delete({where:{id}})` | 6 |
| id-keyed update/delete without companyId in the same where | 92 (guard verified to precede in the sampled set — see ARCH-005) |
| `.upsert(` | 19 |
| `updateMany({where:{…status…}})` (compare-and-set) | 35 |
| `$transaction` | 46 uses in 27 files |
| `createMany` | 8 |
| Raw SQL (`$queryRaw`/`$executeRaw`) | 2 (parameterized advisory locks, `db-locking.ts`) |
| Money-write call sites (`createSalaryExpense`/`recordExpenseMovement`) | 7 — **6 not inside a tx** (ARCH-002) |

## Status vocabulary (`npm run audit:status-transitions`)
| Metric | Value |
|---|---|
| `*_STATUS*` const arrays | 48 |
| Manual `status: "…"` writes | 225 |
| Distinct produced status values | 52 |
| Cancel-spelling drift | `cancelled` ×42 vs `canceled` ×60 — **both spellings live** (ARCH-009) |

## Quality signals
| Metric | Value | Read |
|---|---|---|
| TODO/FIXME/HACK | 11 (all TODO, 0 FIXME/HACK) | very clean |
| `any` usage | 7 | very low |
| `@ts-ignore` / `@ts-expect-error` | 0 | excellent |
| eslint-disable | 7 | low |
| `console.*` | 59 | acceptable; no structured logger (ARCH-018) |
| Hardcoded role/status string literals | ~1,118 | magic strings, not centralized const refs (ARCH-011) |

## Dead-code candidates (`npm run audit:dead-code-candidates`)
- **Prisma models with zero data-access reference:** 0 (all 82 used; some only via `tx.<model>`).
- **Unused component/lib basename candidates:** 8 — `BarChart.tsx`, `UserBadge.tsx`,
  `ai/document-verification.ts`, `club-cash-cards.ts`, and 4 `*.test.ts` files (the `.test.ts` are
  run directly by node, not imported — **false positives**; verify each before acting — ARCH-007).
- **Disabled-feature / 404 tombstones:** 10 (intentional kill-switches; keep).

## Interpretation
The tree is **lean and disciplined** on hygiene (0 ts-ignore, 11 TODO, 7 `any`, no commented-out
code, no unused models) but carries **concentration risk**: 17 files > 500 LOC and the god-action
files (`invoices/actions.ts`, `payroll/periods/actions.ts`) interleave auth+validation+calc+DB+
notify+audit per action. The ~1,118 magic role/status strings and 225 manual status writes are the
main maintainability tax and the surface for the status-machine findings (ARCH-008…011).
