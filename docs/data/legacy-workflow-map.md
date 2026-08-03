# CLUB-OPS — Legacy / V1-V2 Workflow Map

Read-only analysis at `66bc9e3`. `Expense` and `Refund` carry two workflow generations on one table,
discriminated by `entryVersion` (1=legacy, 2=current). Invoice has legacy statuses in one workflow.

## Version summary
| Version | Status source | New record today? | Create writer | UI create path | Canonical |
|---|---|---|---|---|---|
| **Expense v1** | `expenses.ts:85-101` (`confirmed`, `waiting_budget_approval`, `budget_rejected`, `canceled`, `import_reverted`) | **code-live but UI-unreachable** → read-only historical | `expenses/actions.ts:331` `saveExpense` (no entryVersion → 1) | none (`<ExpenseUpload>` unrendered) | Expense v2 |
| **Expense v2** | `expense-simplified.ts:12-21` (`draft`…`verified`,`cancelled`) | **live (canonical)** | `simplified-actions.ts:133`; payroll `salary-expense.ts:37` | `/expenses/simple` | — |
| **Refund v1** | `approval.ts:7-14` (`draft`,`needs_review`,`approved_by_*`,`paid`,`rejected`) | **code-live but UI-unreachable** (v1 rows still actionable via legacy detail form) | `refunds/actions.ts:195` `saveRefund` (no entryVersion → 1) | none (`<RefundUpload>` unrendered) | Refund v2 |
| **Refund v2** | `refund-workflow.ts:6-11` (`draft`,`pending_regional_review`,`needs_correction`,`accounting_in_progress`,`paid`,`canceled`) | **live (canonical)** | `refund-document-actions.ts:69` (entryVersion 2) | `/refunds/new` | — |
| **Invoice legacy status** | `invoices.ts:8-17`; `approved_by_owner` legacy | invoices live; `approved_by_owner` **never written** by any current action | `invoices/actions.ts` | `/invoices` | `approved_by_regional`/`_chief_accountant` |

**Both v1 create actions are still exported and unguarded** (would create a live v1 row if invoked
directly), but no page renders their upload components — effectively read-only historical. v1 refund
mutators are additionally version-gated (`refunds/actions.ts:241,285` reject non-v1).

## Where analytics MERGE v1+v2 — and the numbers DIVERGE
Aggregators filter by **status**, not `entryVersion`, so v1 and v2 rows mix wherever status matches.
Concrete divergences (real number splits inside one report):

- **(a) Approved-but-unpaid refunds: v1 counted, v2 invisible.** Dashboard debt (`analytics.ts:211`)
  and budget "used" for refunds (`budgets.ts:104`) use `APPROVED_UNPAID_STATUSES` = `approved_by_*`.
  A regional-approved **v2** refund sits in `accounting_in_progress` — not in that set → **not**
  counted as network debt / budget-used, while the equivalent v1 refund IS. They converge only at
  `paid`.
- **(b) v2 `verified` expenses dropped from Plan-vs-Fact / overruns.** `computeBudgetFactReport`
  (`budgets.ts:305`) and `computeBudgetOverruns` (`:182`) count only `status==="confirmed"` (v1),
  but the analytics expense total / top-expenses / budget "used" count `confirmed`+`verified`
  (`analytics.ts:204`, `budgets.ts:98`). → a v2 verified expense is in the totals but **silently
  excluded** from the overrun/critical-zone report. **DATA-019 (P1).**
- **(c) Refund month bucketing differs.** `computeUsedKopeks` buckets by `refundDate ?? createdAt`
  (`budgets.ts:108`); the fact report / analytics bucket by `paidAt ?? refundDate ?? createdAt`
  (`budgets.ts:315`, `analytics.ts:269`). v2 refunds never populate `refundDate`, so the same paid
  v2 refund can land in **different months** across the two views. **DATA-021.**
- **(d) Realization point differs by version (by design, asymmetric).** v1 realizes at create
  (`status:"confirmed"`); v2 only at `verified`. A submitted v2 expense is financially invisible
  until verified; the equivalent v1 expense is visible immediately.

## Hard-disabled legacy (kill-switch, `disabled-features.ts`)
Bulk monthly cancel (`expenses/actions.ts:523,528`), public Excel import, manual sales entry, legacy
`balance_snapshot.create` — code remains, entry points return a blocked message + best-effort audit.
The `/expenses/cash` wallet page is retired to a read-only pointer.

## Conclusion (for remediation — NOT done here)
- v1 Expense/Refund are read-only historical in practice but **live-writable in code** — a future
  hardening should guard the v1 create actions (return blocked) so no new v1 row can appear.
- The **status-vs-entryVersion filter asymmetries (a)–(c)** are real cross-report number splits and
  should be reconciled (DATA-019/020/021) so v1 and v2 are counted consistently.
- Retiring v1 needs a v1→v2 data migration (out of scope; DEFERRED, ARCH-012).
