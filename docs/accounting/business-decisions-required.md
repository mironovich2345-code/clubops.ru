# CLUB-OPS — Business Decisions Required (accounting)

Questions that **cannot be settled by code** — each needs a confirmed decision from the owner /
accountant before the corresponding number can be called authoritative. A balancing formula is not
proof of the intended rule. Machine-readable: `docs/audits/data/business-decisions.json`.

| ID | Decision | Current implementation | Why it matters | Linked FIN |
|---|---|---|---|---|
| **BD-01** | Expense recognition for invoices: accrual (`expensePeriod`) or payment date? | **accrual (expensePeriod)** | which month an invoice hits P&L / budget / profit | FIN-015 |
| **BD-02** | Is a client refund a revenue reduction or a separate expense? | **separate expense** (category `refunds`), not a revenue reduction, no Expense row | profit & budget attribution; tax base | FIN-009 |
| **BD-03** | What exactly is "profit"? (Sale+SalesReport vs OFD basis; is payroll included?) | **two definitions**; payroll **NOT** included in any reader | owner P&L trust | FIN-001 |
| **BD-04** | What is "budget fact" — committed (approval) or realized (paid); include v2 verified expenses? | **three definitions**; fact-report is paid-only + confirmed-only (drops v2 verified) | overrun alerts & plan-fact | FIN-003 |
| **BD-05** | Does ФОТ (salary budget) include taxes/contributions? | `salaryBudgetIncludesTaxes` flag, default **OFF**; no tax model | salary budget sizing | FIN-007 |
| **BD-06** | Who is the payer for shared payroll / a shared employee across clubs? | no allocation rule; company-level fallback | club P&L attribution | FIN-014 |
| **BD-07** | How is a regional director's cost allocated across clubs? | regional payment expense filed to the **source club**; `employeeId` may hold a payroll-row id | club cost accuracy | FIN-014 |
| **BD-08** | How is regional-held cash accounted (передача / возврат регионалу)? | `CashRegionalTransfer` reduces ИП only when `confirmed`; return is out-of-band «Иное» | ИП cash truth | FIN-004 |
| **BD-09** | Which cash contour is OFFICIAL — A (wallet) or B (fact)? | **B** canonical in readers; A still written, never reconciled | single cash source of truth | FIN-004 |
| **BD-10** | Internal transfers (ООО→ИП, opening) must never be income — correct? | **correct** (not in profit); but written to both contours | no double income (confirmed OK) | FIN-011 |
| **BD-11** | May a refund be paid from an ИП different from the original sale's legal entity? | LE chosen at payment, validated to the club, **not** to the original sale | cross-entity refund legality | FIN-014 |
| **BD-12** | What is the "fact date" of an expense — accrual, approval, or payment? | **mixed**: expense by `expenseDate`, invoice by `expensePeriod`, refund by `paidAt` | period reporting consistency | FIN-015 |
| **BD-13** | Is VAT/НДС tracked separately? Is there a УСН / tax-liability model? | **NO tax model** — VAT folded into invoice total; `taxes` is just an expense category | tax reporting | FIN-007 |
| **BD-14** | Should manual `Sale`/`SalesReport` revenue and OFD revenue ever coexist? | manual sales disabled, but both models still feed analytics revenue | revenue **double-count** risk | FIN-010 |

## How to use this list
- These are **not bugs to fix silently** — they are policy choices. Implementers must NOT pick a rule
  unilaterally; get the decision, record it here, then the corresponding FIN remediation can proceed.
- **Highest-urgency (block launch or the numbers can't be trusted):** BD-03 (profit), BD-04 (budget
  fact), BD-09 (official cash contour), BD-13 (tax model), BD-02 (refund treatment).
- The rest are important but can be ratified in parallel with the P0/P1 code fixes.
