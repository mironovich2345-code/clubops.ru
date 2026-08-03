# CLUB-OPS — Math & Rounding Map

Every rounding rule in the money paths at `d161c15`. Money = integer kopeks; floats appear only at
the ruble I/O edges and in display/ratio math. Two ruble-ceil helpers exist:
`ceilToRubleKopeks` (BigInt `ceilDiv`, `refund-membership.ts:58`) rounds a kopeck value **up to a whole
ruble** (result always ×100).

## Rounding by computation
| # | Computation | File:line | Rule | Risk |
|---|---|---|---|---|
| 1 | `rublesToKopeks` | `money.ts:8` | `Math.round(rubles*100)` | float input → one round (correct) |
| 2 | refund membership total `X·P/T` | `refund-membership.ts:124` | BigInt **ceil-to-ruble**, per-day never pre-rounded | `numerator===0n` + `T>0` guards |
| 3 | refund PT `X·(N−E)/N` | `refund-personal-training.ts:99` | BigInt **ceil-to-ruble**, `X/N` never pre-rounded | `N>0`, `numerator===0n`, negative-guard |
| 4 | **payroll engine 1** `applyBp` | `calc.ts:17` | `ceilToRubleKopeks(Math.round(k·bp/BP))` — **double round + ceil-to-ruble** | back-to-back rounding |
| 5 | `calcSalaryByShifts` | `calc.ts:24` | `ceilToRubleKopeks(Math.round(base·shifts/norm))`, `norm>0?:1` | ruble-ceil |
| 6 | `calcSeniorGroup` | `calc.ts:94` | `fixed + applyBp(sales)` (fixed not ceiled) | **mixed** — total not a whole ruble |
| 7 | `planFactAdjustmentBp` | `calc.ts:176` | `200·Math.ceil(|devPct|)`; `plan<=0`→manual review | **ceil on percentage-points** |
| 8 | `planFactPart` | `calc.ts:187` | `ceilToRubleKopeks(Math.round(base·(BP+adj)/BP))` | ruble-ceil |
| 9 | **payroll engine 2** `pct` | `formulas.ts:34` | `Math.round(k·bp/BP)` — **kopeck round, NO ruble ceil** | **diverges from #4** |
| 10 | `managerDirection` | `formulas.ts:43` | adjustment `deviation·2` clamped (no ceil); `Math.round(base·(BP+adj)/BP)` | **diverges from #7/#8** (magnitude + rounding) |
| 11 | `completionBp` e1 vs e2 | `calc.ts:176` / `formulas.ts:16` | e1 `plan<=0`→manual review; e2 `plan<=0`→100% | **plan≤0 handled differently** |
| 12 | senior/group trainers (e2) | `formulas.ts:215` | Σ of separately-rounded `pct()` + unrounded fixed | **component-wise accumulation** |
| 13 | `computeSalaryBudgetVariance` | `budget-linkage.ts:34` | `variance/forecast·100`, **null when forecast≤0** | no divide-by-zero, no false 0% |
| 14 | analytics percentages | `analytics.ts:284,563,588` | float `%`; `changePercent` null when prev≤0; plan/budget `>0` guards | display only |
| 15 | analytics averages | `analytics.ts:677,730` | `Math.round(sum/count)`, `count>0?:0` | kopeck round |
| 16 | cash/collections totals | `cash-balances.ts`, `collections-history.ts:99` | **pure integer** sums, no division | contour math never rounds |

## Same-value / different-rounding pairs (FIN-008)
1. **% of money:** engine 1 `applyBp` (ceil-to-ruble, pre-round, `calc.ts:17`) vs engine 2 `pct`
   (kopeck-round, `formulas.ts:34`). Any commission/revenue-% differs by up to ~1 ₽ per component.
   Both are live: `calc.ts` backs non-role scheme types; `formulas.ts` (via `role-compute.ts`) backs
   the `role_*` categories.
2. **Manager plan-fact salary computed by two engines:** engine 1 (`planFactAdjustmentBp`+`planFactPart`,
   adjustment `200·ceil(|dev%|)`, ruble-ceil) vs engine 2 (`managerDirection`, adjustment `dev·2`
   clamped, kopeck-round). **Different adjustment magnitude AND different final rounding** for the same
   conceptual salary.
3. **plan≤0 divergence:** engine 1 → manual review + 100% deviation; engine 2 → silent 100% completion.
4. **Component-wise vs total rounding:** manager (2 parts) and senior-group (3–4 parts) sum
   separately-rounded components → kopeck drift vs rounding once.

## Guards present (no divide-by-zero / NaN / overflow)
`norm>0?:1/0/15`, `plan<=0` guards, `T>0`/`N>0` refund validation, `forecast>0`, `prev<=0`/`count>0`/
`daysLeft>0` in analytics, BigInt `numerator===0n` guards, `raw<0` negative-guard in PT contract-rate.
No `parseFloat` in payroll; no float persisted to a `*Kopeks` column without `Math.round`/BigInt ceil.
Integer kopeks make overflow a non-issue at realistic magnitudes.

## Conclusion
The math is **numerically safe** (guards everywhere, no float storage) but **not internally
consistent**: two payroll engines round the same kind of value by different rules, so the same
economic input can produce ±1 ₽/component differences depending on which engine (scheme type) runs.
This is a **correctness-of-rule** issue (FIN-008), not a crash risk — and "the formula balances" does
not make the rounding rule the *intended* one (business decision).
