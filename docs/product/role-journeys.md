# CLUB-OPS — Role Journeys (end-to-end)

Code-based at `9c43548`. Verdict per role: **can it complete essential daily work in-product without a
spreadsheet?** Landing pages from `landingPageForRole` (`auth.ts`). Every action re-checks role +
company/club scope server-side.

## 1. Управляющий (manager) — lands `/dashboard`
- **Dashboard:** non-strategic, **own-club sales card** (manager not in dashboard financial roles); no network analytics, no company audit, no OFD-sales/payments/balances/users/settings (`ROLE_PAGE_ACCESS.manager`). Club **cash** card can appear (manager holds collections access — club-scoped, confirm intended).
- **Daily:** create expenses/invoices/refunds (own-only visibility), record cash collections/withdrawals, submit for review, confirm a transfer to the regional. **Monthly:** payroll working screen + submit.
- **Spreadsheet-free? MOSTLY YES** — two friction dead-ends: a *returned* refund's document step is UI-unreachable (UX-001/R3, UNVERIFIED); an over/no-budget expense sticks in `draft` if no active regional (E3).
- **Mismatch check:** own club only, no profit/network analytics/company audit. ✔

## 2. Региональный директор (regional) — lands `/dashboard`
- **Dashboard:** scoped to **own clubs** + the **3 «Требуют внимания» task cards** (invoice needs_review / expense pending_regional / refund pending_regional_review). ✔
- **Daily:** approve/return/reject invoices & refunds, approve expense budget overruns (assigned clubs), create operational records; **cannot self-approve** (blocked). Morning 10–15 min: the 3 cards surface overdue/nearest-due + club breakdown; cash-shortfall/budget-deviation require opening analytics/collections (not on the cards).
- **Spreadsheet-free? YES.** Dead-end: `/refunds/new` reachable by direct URL but `createRefundDraft` requires manager (UX-006/R2).

## 3. Бухгалтер (accountant) — lands `/workspace`
- **Workspace:** task queues (invoices to pay, refunds, expenses on review, cash ops, sales) — **not** the strategic dashboard. ✔
- **Daily:** verify/confirm expenses, pay invoices (full/partial, with a visible payment-guard reason), pay refunds, review AI invoice data. No analytics/dashboard (by design).
- **Spreadsheet-free? YES** for the accounting contour.

## 4. Главный бухгалтер (chief) — lands `/workspace`
- Everything the accountant has **+ reversal** (sole `canReverseInvoicePayment`) + month close/reopen-execute. Inherits all accountant permissions.
- **Spreadsheet-free? YES.** Dead-end: `cancelPayrollObligation` (reverse a mis-raised «Зарплата к выплате») has **no UI** (UX-003).
- **Reversal clarity:** the invoice payment history shows who/when/reason + the reversedBy/reversalReason — the user can see exactly what was reversed and the new derived status (strong audit-trail UX). Payroll reversal lacks a UI entirely.

## 5. Собственник (owner) — lands `/dashboard`
- **Dashboard:** strategic multi-company read-only (no account-switching), club cards, month-reopen approvals, non-advertising budget-overrun approval. **Does NOT get auto-reversal/pay rights** (strategic; the pay/reverse actions are accountant/chief only). ✔
- **Spreadsheet-free? YES** for oversight; cannot execute finance ops (by design).
- **Caveat:** the "Финансовый итог/Прибыль" card silently switches definition (OFD-net vs sales−spend) and **omits payroll** — treat profit as indicative (UX-005).

## 6. Генеральный директор (GD) — lands `/dashboard`
- Same strategic dashboard **+** sales-plan + plan/budget import; **advertising overrun approver (exclusive)**; primary user-management role. No auto-reversal/pay. ✔
- **Spreadsheet-free? YES** for planning/oversight.

## 7. Маркетолог (marketer) — lands `/dashboard`
- **Only** dashboard + analytics, **zero capabilities**; sales-only cards, no cash/OFD/expenses/profit. ✔ Pure viewer by design.

## Cross-role verdict
**Every role can complete its essential daily work in-product without a spreadsheet.** Role
boundaries are correct (verified against the actual guards, not just UI). The friction is not access
or navigation — it is **(a) workflow dead-ends** (refund correction R3, expense owner-budget E2,
payroll/mandatory reversal & settlement UX-003), **(b) financial figures the user can't fully trust**
(competing profit/cash definitions UX-005, payroll "paid" attestation UX-004), and **(c) missing
states** (no loading; permission = silent redirect; no-access looks like 404). These, plus the
carried-in P0 money-integrity items, are what stand between "built" and "operationally ready."
