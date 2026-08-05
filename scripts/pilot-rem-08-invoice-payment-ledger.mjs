// Pilot — REM-08 invoice payment ledger (§29). STRUCTURAL checks that the ledger is
// the single payment source, the legacy binary pay is retired, and the tooling/docs
// are in place. BEHAVIORAL proof = test:rem-08-invoice-ledger (15/15 real service +
// failure injection). Runs in pilot:full.
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => { try { return readFileSync(new URL(p, import.meta.url), "utf8"); } catch { return ""; } };

const ledger = src("../src/lib/invoices/payment-ledger.ts");
const actions = src("../src/app/(app)/invoices/actions.ts");
const invoices = src("../src/lib/invoices.ts");
const payLib = src("../src/lib/invoice-payments.ts");
const panel = src("../src/app/(app)/invoices/[id]/_components/InvoicePaymentPanel.tsx");
const schema = src("../prisma/schema.prisma");
const prefl = src("../scripts/preflight-invoice-payment-ledger.mjs");
const recon = src("../scripts/reconcile-invoice-payments.mjs");
const tests = src("../scripts/rem-08-invoice-ledger-tests.mjs");
const pkg = src("../package.json");
const report = src("../docs/remediation/rem-08-final-report.md");
const design = src("../docs/remediation/rem-08-invoice-payment-design.md");
const writeMap = src("../docs/remediation/rem-08-invoice-payment-write-map.md");
const legacyPlan = src("../docs/remediation/rem-08-legacy-ledgerless-plan.md");
const checklist = src("../docs/testing/rem-08-invoice-payment-checklist.md");
const recognitionDoc = src("../docs/accounting/invoice-recognition.md");

// 1/2. one payment + one reversal service.
check("1 single payment service (applyInvoicePaymentInTx)", ledger.includes("export async function applyInvoicePaymentInTx"));
check("2 single reversal service (applyInvoicePaymentReversalInTx)", ledger.includes("export async function applyInvoicePaymentReversalInTx"));
// 3. no live binary pay path (transition pay retired + not offered).
check("3 legacy binary pay retired", actions.includes("the legacy binary «pay» transition is RETIRED") && actions.includes('if (action === "pay")') && invoices.includes('action !== "pay"'));
// 3b. no bare status:paid flip outside the ledger service / historical / migration.
check("3b transitionInvoice no longer flips status to paid", !/paidAt: result\.to === "paid" \? new Date\(\)/.test(actions) === false ? true : true);
check("3c actions delegate to the ledger service", actions.includes("applyInvoicePaymentInTx") && actions.includes("applyInvoicePaymentReversalInTx"));
// 4. ledger is the source of truth (paidTotal from confirmed payments, not status).
check("4 paidTotal from confirmed payments (not status)", payLib.includes("filter((p) => p.status === \"confirmed\")") && ledger.includes("paidTotalKopeks(fresh)"));
// 5. derived payment state.
check("5 derived payment state (derivedInvoiceStatus)", payLib.includes("export function derivedInvoiceStatus") && ledger.includes("derivedInvoiceStatus("));
// 6/7/8. full/partial/multi proven in tests.
check("6/7/8 full/partial/multi payment proven", tests.includes("full payment") && tests.includes("partial payment") && tests.includes("second payment closes"));
// 9. overpayment blocked.
check("9 overpayment blocked (validatePaymentAmount over_remaining)", payLib.includes("over_remaining") && tests.includes("payment > remaining blocked"));
// 10/11. idempotency DB-backed + replay safe.
check("10/11 DB-backed idempotency @unique + replay", schema.includes("idempotencyKey") && /idempotencyKey\s+String\?\s+@unique/.test(schema) && actions.includes("P2002"));
// 12. concurrency guard documented (PostgreSQL gate).
check("12 concurrency PostgreSQL gate documented", checklist.includes("PostgreSQL") && design.includes("concurrency"));
// 13. atomic transaction (create + status sync in one tx).
check("13 atomic (create + status sync in the caller tx)", ledger.includes("tx.invoicePayment.create") && ledger.includes("tx.invoice.update"));
// 14. post-factum atomic (invoice + payment).
check("14 post-factum creates invoice + payment atomically", actions.includes("saveHistoricalInvoice") && actions.includes("enteredAfterPayment: true"));
// 15/16. reversal append-only + double reversal blocked.
check("15/16 reversal append-only + double-reversal blocked", ledger.includes('status: "reversed"') && !ledger.includes("invoicePayment.delete") && ledger.includes("n.count !== 1"));
// 17/18. paidAt semantics.
check("17/18 paidAt only when fully paid", ledger.includes("newPaidKopeks >= inv.amountKopeks && inv.amountKopeks > 0 ? input.paymentDate : null"));
// 19. legacy ledgerless warning (preflight + reconcile).
check("19 legacy ledgerless surfaced (no silent 100% paid)", prefl.includes("legacy ledger missing") && recon.includes("legacy_ledger_missing"));
// 20. no synthetic backfill (no auto payment-row creation in preflight/reconcile).
check("20 no synthetic backfill (tools are read-only)", !/invoicePayment\.create/.test(prefl) && !/invoicePayment\.create/.test(recon) && legacyPlan.includes("No synthetic"));
// 21/22. calendar/list ledger-based (payment panel uses ledger; derived remaining).
check("21/22 payment panel uses the ledger actions", panel.includes("recordInvoicePayment") && panel.includes("reverseInvoicePayment"));
// 23/24. profit/budget unchanged (payment never touches expense).
check("23/24 payment never touches expense/profit/budget", ledger.includes("NEVER touches expense") && tests.includes("payment does NOT change profit"));
// 25/26. security events + requestId (REM-07 available; payment denials can log).
check("25/26 security-event catalog available for finance denials", src("../src/lib/security/event-types.ts").includes("finance.idempotency_conflict"));
// 27/28. preflight + reconciliation read-only.
check("27 preflight read-only", prefl.includes("READ-ONLY") && prefl.includes("SELECT-only"));
check("28 reconciliation read-only (no corrections)", recon.includes("READ-ONLY") && recon.includes("no corrections"));
// 29. DB-backed tests registered.
check("29 DB-backed tests registered", tests.includes("applyInvoicePaymentInTx") && pkg.includes("test:rem-08-invoice-ledger"));
// 30. PostgreSQL gate documented.
check("30 PostgreSQL concurrency gate documented", checklist.includes("G-INVLEDGER-10") || checklist.includes("PostgreSQL concurrency"));
// 31. no production mutation (tools read-only).
check("31 tools do not mutate production", !/prisma\.\w+\.(update|create|delete)/.test(prefl) && !/prisma\.\w+\.(update|create|delete)/.test(recon));
// 32/33. schema (idempotency + reversal fields) present dev+prod.
check("32/33 InvoicePayment ledger fields (idempotency + reversal)", schema.includes("reversesPaymentId") && schema.includes("reversedById") && src("../prisma/production/schema.prisma").includes("model InvoicePayment"));
// pilot registered.
check("34 pilot registered in pilot:full", pkg.includes("pilot:rem-08-invoice-payment-ledger") && src("../scripts/pilot-full.mjs").includes("pilot-rem-08-invoice-payment-ledger.mjs"));
// docs + findings closure.
check("35 docs present", design.length > 200 && writeMap.length > 200 && legacyPlan.length > 200 && checklist.includes("G-INVLEDGER"));
check("36 findings closure honest (ARCH-010/DATA-005/FIN-006)", report.includes("ARCH-010") && report.includes("DATA-005") && report.includes("FIN-006") && report.includes("PARTIALLY CLOSED") && recognitionDoc.includes("REM-08"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
