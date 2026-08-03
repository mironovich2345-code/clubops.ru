# FULL AUDIT 6/6 — Product, UX, Role Workflows, Operational Readiness (Findings)

Commit `9c43548`. Read-only, code-based (no live device — device-only items marked UNVERIFIED). **No
business logic, schema, RBAC, UI, or production data changed.** Severity S0→S3; category. Priorities in
`docs/release/final-remediation-backlog-to-2026-08-18.md`. Machine data:
`docs/audits/data/{product-readiness,role-journeys,ux-findings,live-gates}.json`.

## Headline verdict
**CLUB-OPS is a genuinely built product, not a scaffold — every role can complete its essential daily
work in-product without a spreadsheet.** The gap to "operationally ready" is: P0 money-integrity
(carried in), a handful of **workflow dead-ends**, **financial figures the UI shows as competing
numbers**, and **missing/undifferentiated states** — not access or navigation.

## Severity roll-up
| Severity | Count | IDs |
|---|---|---|
| **S1 high** | 2 | UX-004, UX-005 |
| **S2 medium** | 5 | UX-001, 002, 003, 006, 007 |
| **S3 low** | 8 | UX-008…015 |
| **S0** | 0 | — |
**Priority:** P0:1 (UX-005, folds into REM-02/05) · P1:6 · P2:7 · DEFERRED:1.

## What works well (explicit)
- **Role journeys all correct** (manager own-club, regional 3 cards, accountant/chief workspace, owner/GD strategic no-auto-reversal, marketer view-only) — verified against guards.
- **Forms are strong:** `useFormState`/`useFormStatus` everywhere → **data preserved on a server-action error**; double-submit/idempotency guards; **visible "why you can't pay" reasons** (invoice `payBlockReason`, refund missing-legal-entity, payroll not-payable) — best-in-class on the money forms.
- **AI review UX is a standout:** confidence surfaced with tone, low-confidence flagged, all fields editable, **editing a financial field voids approval** (fingerprint) end-to-end, and the payment-block reason shown to the user with server/UI parity.
- **Mobile foundation is mature & systemic** (safe-area, no-h-scroll discipline, keyboard-aware sticky CTA, sheets, card variants for finance lists) — no code-level blocker (device render UNVERIFIED).
- **Audit-trail UX strong on money movements** (invoice payments, snapshot correct/cancel, month close show who/when/why + reversedBy/reason).
- **Files:** camera capture, multi-file, remove-before-submit, Russian errors + filename wrapping.

---

## UX-001 — Refund correction loop is a UI dead-end (R3)
- **S2 · workflow · P1 · UNVERIFIED (needs live).** A returned (`needs_correction`) refund's "Продолжить исправление" → `/refunds/new/[id]` which **redirects a non-draft to the record view**, so the **document/requisites edit step is UI-unreachable**; only the calc/resubmit URL accepts `needs_correction`. A manager can resubmit unchanged but may be unable to re-upload a corrected document. **Impact:** the return-for-correction cycle can't be completed in-product for refunds. **Remediation:** allow the doc/requisites step for `needs_correction`. **Effort:** S.

## UX-002 — Expense owner-budget approval branch is dead (E2)
- **S2 · workflow · P1.** `pending_owner_budget_approval` is **never reached** — `submitExpense` routes purely by creator role and ignores the budget route; so `approveOwnerBudget`, `canApproveOwnerExpense`, and the "Согласовать (собственник)" button are **dead** in the current flow. **Impact:** the intended owner sign-off for large/over-budget expenses never happens. **Remediation:** wire the budget route (or remove the dead branch + button). **Effort:** M.

## UX-003 — Obligation reversal & per-occurrence settlement have no UI
- **S2 · workflow · P1.** Chief's `cancelPayrollObligation` (reverse a mis-raised «Зарплата к выплате») has **no UI trigger anywhere** (code-only). Mandatory payments have **no per-occurrence "paid"** → monthly plans emit obligations forever and render **perpetual "overdue"** (only pause/cancel stops them). **Impact:** two obligations can't be resolved in-product. **Remediation:** add the reversal action + a per-occurrence settle. **Effort:** M.

## UX-004 — Payroll "Выплачен" is an unreconciled attestation
- **S1 · workflow/finance · P1.** `mark_paid`/`mark_partially_paid` are **manual attestations not reconciled to `paidKopeks`** — a period can read "Выплачен" while its calcs still have positive `remainingKopeks`. **Impact:** a user can believe salaries are fully paid when they are not → a wrong financial decision. **Remediation:** derive/guard the paid state from `remaining` (ties REM-01). **Effort:** S.

## UX-005 — The UI shows competing profit/cash definitions as single numbers
- **S1 · usability/finance · P0 (folds into REM-02/REM-05).** (a) The "Финансовый итог" slot renders `useOfd ? ofdResultKopeks : profitKopeks` — **two profit definitions with a silently-switching label** (`analytics/page.tsx:432`), and **profit omits payroll**. (b) ООО cash appears as **two numbers on one screen** — "Прогноз ООО" (snapshot) vs "Наличные ООО" (fact) with no disambiguation (FIN-004). (c) Dashboard "Абонементы/ПТ" is always-OFD while the analytics list falls back to report sales → **drill-through numbers won't reconcile**. (d) `breakEvenKopeks`/"Окупаемость" is documented but **dead/mislabeled**. **Impact:** users can't trust the headline financial figures → wrong decisions. **Remediation:** ratify BD-03/04/09, then show one labeled number per concept (REM-02/05). **Effort:** M (after decisions).

## UX-006 — New-company onboarding: demo-company trap
- **S2 · onboarding · P1.** The **first-ever registrant is auto-attached to a hardcoded "Демо компания"** (`seed.ts` + `auth-actions.ts:107`); on a real prod deploy, company #1 = demo unless the operator discards a throwaway first user. Plus env prerequisites (`APP_URL`/SMTP/OFD secrets) with no UI. **Impact:** a botched first onboarding. **Remediation:** handle the demo bootstrap for prod (runbook + code guard); env-prereq checklist. **Effort:** S. See `new-company-onboarding.md`.

## UX-007 — Missing / undifferentiated states (loading, permission, empty, error)
- **S2 · error/states · P1.** **No loading states** (0 `loading.tsx`; every page blocks). **Permission denied = silent redirect** (no message). **List true-empty = filter-empty** (same "нет данных" string on invoices/refunds/collections/budgets/analytics). Detail pages **collapse no-access + not-found + deleted into one 404** (expenses/invoices/refunds/analytics-expenses). **Impact:** a user can't tell "no data" from "no access" from "load error" from "filter matched nothing" — and a failure can look like empty. **Remediation:** distinct empty/filter-empty/permission/error states; loading skeletons. **Effort:** M. (Positive reference: `RegionalReviewCards` distinguishes error≠empty; loaders don't swallow to empty.)

## UX-008 — Raw error text leaks to the user (2 payroll actions)
- **S3 · error · P2.** `payroll/change-requests/actions.ts:554` and `payroll/schemes/actions.ts:144` render `${(e as Error).message}` raw. Elsewhere errors are curated Russian. **Remediation:** curated messages. **Effort:** XS.

## UX-009 — Terminology overload & label-map fragmentation
- **S3 · terminology · P2.** «Отменить» means **5 different things** (cancel a financial record / dismiss a dialog / discard a draft / reverse a confirmation / "cannot be undone") — including twice in one sentence ("Отменить счёт? Действие нельзя отменить."). The **pay action** is labeled with the **status word** "Оплачено" (no «Оплатить»/«Подтвердить оплату»). `cancelled`/`canceled` both reach labels. **15+ un-unified status-label maps**, and `EXPENSE_STATUS_LABELS` is **duplicated** (`exports.ts:53` vs `expenses.ts:95`) → CSV export and UI can diverge; multiple independent status→color functions. **Remediation:** one label/tone source; disambiguate «Отмен-». **Effort:** M.

## UX-010 — Dashboard card consistency
- **S3 · dashboard · P2.** No **period label** on club money cards (rely on the page month selector; cash is "as of now" next to month-scoped expenses). No **legal-entity label** on "Фактические расходы"/"Результат"/"Выручка ОФД". Analytics KPI cards (Прибыль/Долги/Прогноз) **don't drill through** (unlike ClubCards/RegionalReviewCards). **Remediation:** per-card period + entity labels; drill-through. **Effort:** S.

## UX-011 — No consistent focus-managed modal pattern (a11y)
- **S3 · accessibility · P2.** No shared focus-trapped Dialog primitive; destructive confirmations use native `window.confirm()` + `<details>/<summary>` (no `role="dialog"`); the mobile `Sheet` is hand-rolled (focus-trap unverified). Icon buttons are largely labeled and status is not color-only (StatusBadge enforces text) — those are fine. **Remediation:** a focus-trapped dialog primitive. **Effort:** M.

## UX-012 — Form/file polish
- **S3 · forms/files · P2.** No visible required-asterisk/`aria-required` (HTML-attribute-only). `PaymentsSection` uses `type="number"` vs the app's `inputMode="decimal"` standard. Some forms don't reset after success (re-submit risk; duplicate guards exist for invoices). **No true upload progress bar** (spinner only) — a gap on large files over mobile data. Refund quick-forms show a generic "Ошибка." with no next step. **Remediation:** required markers, consistent money input, progress indicator. **Effort:** S.

## UX-013 — Expense/refund approval detail lack a full timeline
- **S3 · audit-trail UX · P2.** Money-movement records have strong inline audit UX, but the **expense/refund approval detail pages show only the latest action's reason**, not a chronological who-approved-when timeline. **Remediation:** render the approval history per record. **Effort:** S.

## UX-014 — Confirmed regional transfer can't be undone in UI
- **S3 · workflow · P2.** A confirmed transfer is corrected only via a manual «Приход Иное (source=regional)» with **no linkage** to the original → easy to mis-enter, hard to audit. **Remediation:** a linked reverse operation. **Effort:** S.

## UX-015 — DEFERRED: white-label / stubs
- **DEFERRED.** OFD **fitness-vocabulary hardcodes** (non-fitness tenant → sales fall to "Иное"); Documents page is a **stub**; Balances **redirects**; Saby behind a flag. Not launch-affecting for a fitness network. **Remediation:** white-label i18n + parameterized OFD heuristics (post-launch).

## Notifications & tasks (§25 — minimum for launch)
Present: **dashboard task cards** (regional 3 cards, accountant workspace queues), overdue/nearest-due
badges, **email** (OTP + invitations, needs SMTP). Deferred: **Telegram** (scaffolded, off). **Minimum
for launch:** the dashboard task queues + email OTP/invites are sufficient; no push required. Telegram
stays DEFERRED (do not implement).

## Reports & exports (§23)
CSV/XLSX builders exist but the **CSV export routes are hard-404** (disabled); when re-enabled they need
the formula-injection fix (SEC-010) **and** a bookkeeper-legibility pass (period/entity/totals labeled).
**Do not treat exports as ready** — they download but are currently disabled and, when enabled, must be
made comprehensible to an accountant.

## Desktop (§16)
Finance lists use a table on `lg+` and cards below; forms are one-/two-column. No desktop blocker found
in code (density/zoom UNVERIFIED). The accountant workspace is task-queue-oriented (good for daily use).
