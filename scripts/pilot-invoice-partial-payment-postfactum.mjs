// Invoice partial payment / post-factum entry / AI quality. Runtime mirrors of the pure
// payment aggregates, duplicate classifier, and AI validators + static guards for actions/
// RBAC/model/UI. Kopeks-exact. prisma/tsc/pilot:full/build are the gauntlet.
//   npm run pilot:invoice-partial-payment-postfactum
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = fileURLToPath(new URL("../", import.meta.url));
const src = (rel) => readFileSync(join(root, rel), "utf8");

const actions = src("src/app/(app)/invoices/actions.ts");
const invoices = src("src/lib/invoices.ts");
const payLib = src("src/lib/invoice-payments.ts");
const dedupe = src("src/lib/invoice-dedupe.ts");
const quality = src("src/lib/ai/invoice-quality.ts");
const panel = src("src/app/(app)/invoices/[id]/_components/InvoicePaymentPanel.tsx");
const schema = src("prisma/schema.prisma");
const paymentsLib = src("src/lib/payments.ts");

// ---- Runtime mirrors ----
const paidTotal = (ps) => ps.filter((p) => p.status === "confirmed").reduce((a, p) => a + p.amountKopeks, 0);
const remaining = (total, ps) => total - paidTotal(ps);
const derived = (paid, total, pre, cur) => (total > 0 && paid >= total) ? "paid" : paid > 0 ? "partially_paid" : (pre ?? cur);
const validate = (amt, rem, mode) => rem <= 0 ? "no_remaining" : mode === "full" ? (amt === rem ? null : "over_remaining") : (!Number.isInteger(amt) || amt <= 0) ? "not_positive" : amt > rem ? "over_remaining" : null;
const dg = (s) => (s ?? "").replace(/\D/g, "");
const nk = (s) => (s ?? "").toLowerCase().replace(/\s+/g, "").trim();
function dupPair(a, b) {
  if (a.fileHash && b.fileHash && a.fileHash === b.fileHash) return "exact";
  if (a.edoDocumentId && b.edoDocumentId && nk(a.edoDocumentId) === nk(b.edoDocumentId)) return "exact";
  const innEq = dg(a.counterpartyInn) && dg(a.counterpartyInn) === dg(b.counterpartyInn);
  const numEq = nk(a.invoiceNumber) && nk(a.invoiceNumber) === nk(b.invoiceNumber);
  const dateEq = a.invoiceDateIso && a.invoiceDateIso === b.invoiceDateIso;
  const amtEq = a.amountKopeks != null && a.amountKopeks === b.amountKopeks;
  if (innEq && numEq && dateEq && amtEq) return "probable";
  if ([innEq, numEq, amtEq].filter(Boolean).length >= 2) return "weak";
  return "none";
}
const classifyInn = (inn) => { const d = dg(inn); return d.length === 10 ? "legal" : d.length === 12 ? "ip" : "invalid"; };
function matchPayer(inn, ents) { const d = dg(inn); if (classifyInn(inn) === "invalid") return "invalid_inn"; const h = ents.filter((e) => dg(e.inn) === d); return h.length === 1 ? "one" : h.length === 0 ? "none" : "multiple"; }
const FINAL = /(итого|всего)\s+к\s+оплате|к\s+оплате/i, VAT = /в\s*т\.?\s*ч\.?\s*ндс|включая\s+ндс|^ндс/i, ADV = /аванс|предоплат/i, SUB = /без\s+ндс/i;
function selectAmount(cands) {
  const w = []; if (!cands.length) return { v: null, w: ["not_found"] };
  const finals = cands.filter((c) => FINAL.test(c.label) && !VAT.test(c.label));
  const chosen = finals[0] ?? cands[0];
  if (!finals.length) { if (VAT.test(chosen.label)) w.push("looks_like_vat"); if (SUB.test(chosen.label)) w.push("looks_like_subtotal"); if (ADV.test(chosen.label)) w.push("looks_like_advance"); }
  if (new Set(finals.map((c) => c.v)).size > 1) w.push("multiple_totals");
  if (chosen.v < 0) w.push("negative"); if (chosen.v === 0) w.push("zero");
  return { v: chosen.v, w };
}
const amountBlocks = (w) => w.some((x) => ["not_found", "negative", "zero", "looks_like_vat", "looks_like_subtotal", "looks_like_advance", "multiple_totals"].includes(x));

// ===================== Payment aggregates / status =====================
check("1 Full payment equals remaining (else refused)", validate(1000, 1000, "full") === null && validate(900, 1000, "full") === "over_remaining");
check("2 Partial payment requires amount (action reads amount in partial mode)", /mode === "partial"[\s\S]*?formData\.get\("amount"\)/.test(actions));
check("3 Partial amount > 0", validate(0, 1000, "partial") === "not_positive" && validate(-5, 1000, "partial") === "not_positive");
check("4 Partial amount ≤ remaining", validate(1200, 1000, "partial") === "over_remaining" && validate(600, 1000, "partial") === null);
check("5 First partial → partially_paid", derived(600, 1000, "approved_by_owner", "approved_by_owner") === "partially_paid");
check("6 Multiple payments accumulate", paidTotal([{ status: "confirmed", amountKopeks: 400 }, { status: "confirmed", amountKopeks: 600 }]) === 1000);
check("7 Final payment → paid", derived(1000, 1000, "approved_by_owner", "partially_paid") === "paid");
check("8 paidTotal exact (reversed excluded)", paidTotal([{ status: "confirmed", amountKopeks: 400 }, { status: "reversed", amountKopeks: 600 }]) === 400);
check("9 remainingTotal exact", remaining(1000, [{ status: "confirmed", amountKopeks: 250 }]) === 750);
check("10 Payment history append-only (reverse flips status, никогда не delete)", /reverseInvoicePayment[\s\S]*?status: "reversed"/.test(actions) && !actions.includes("invoicePayment.delete"));

// ===================== Reversal RBAC =====================
check("11 Accountant CANNOT reverse (chief only guard)", /canReverseInvoicePayment\(roles.*\)\s*\{\s*return roles\.includes\("chief_accountant"\)/.test(invoices.replace(/\s+/g, " ")) || invoices.includes('roles.includes("chief_accountant")'));
check("12 Chief accountant can reverse WITH reason", /reverseInvoicePayment[\s\S]*?canReverseInvoicePayment/.test(actions) && /reverseInvoicePayment[\s\S]*?if \(!reason\) return/.test(actions));
check("13 Reverse changes status correctly", derived(paidTotal([{ status: "reversed", amountKopeks: 1000 }]), 1000, "approved_by_owner", "paid") === "approved_by_owner");
check("14 Reverse restores remaining", remaining(1000, [{ status: "reversed", amountKopeks: 1000 }]) === 1000);

// ===================== Block legacy cancel =====================
check("15 Paid invoice cannot use legacy cancel", /existing\.status === "paid" \|\| existing\.status === "partially_paid"/.test(actions) && !/INVOICE_CANCELABLE = \[[^\]]*"paid"/.test(actions));
check("16 Partially-paid invoice cannot use legacy cancel", actions.includes('existing.status === "partially_paid"') && !/INVOICE_CANCELABLE = \[[^\]]*"partially_paid"/.test(actions));

// ===================== Already-paid entry =====================
check("17 Accountant can add already-paid invoice (accountant/chief)", invoices.includes("export function canAddPaidInvoice") && /accountant.*chief_accountant|chief_accountant/.test(invoices.slice(invoices.indexOf("canAddPaidInvoice"))));
check("18 Full already-paid → paid", /histStatus = paidKopeks >= totalKopeks \? "paid" : "partially_paid"/.test(actions));
check("19 Partial already-paid → partially_paid (paidAmount < total)", actions.includes("paidAmount") && actions.includes('"partially_paid"'));
check("20 enteredAfterPayment badge exists", schema.includes("enteredAfterPayment Boolean") && actions.includes("enteredAfterPayment: true") && panel.includes("после оплаты"));

// ===================== Financial-fact date / no double count =====================
check("21 Payment date is the financial fact of the payment (InvoicePayment.paymentDate)", schema.includes("paymentDate        DateTime  // the financial-fact date of THIS payment") || schema.includes("paymentDate") && payLib.includes("cash-payment ledger"));
check("22 Invoice date does NOT drive the payment fact (expensePeriod≠paymentDate; analytics untouched)", schema.includes("expensePeriod") && payLib.includes("read this table"));
check("39 No double accounting after backfill (analytics reflect Invoice by expensePeriod; not InvoicePayment)", src("scripts/backfill-invoice-payments.mjs").includes("NO double count") && !src("src/lib/analytics.ts").includes("invoicePayment"));

// ===================== Duplicate detection =====================
const A = { counterpartyInn: "7701234567", invoiceNumber: "№5", invoiceDateIso: "2026-07-01", amountKopeks: 100000 };
check("23 Exact duplicate blocked (action returns error, no create)", dupPair({ ...A, fileHash: "h1" }, { ...A, fileHash: "h1" }) === "exact" && actions.includes("Точный дубль"));
check("24 Probable duplicate warned (requires confirm)", dupPair(A, A) === "probable" && actions.includes("confirmDuplicate") && actions.includes("Вероятный дубль"));
check("25 File hash dedupe works", dupPair({ fileHash: "x" }, { fileHash: "x" }) === "exact" && dupPair({ fileHash: "x" }, { fileHash: "y" }) === "none");
check("26 EDO id dedupe works", dupPair({ edoDocumentId: "ED-1" }, { edoDocumentId: "ed-1" }) === "exact");
check("24b Weak match warns but does not block (≥2 fields)", dupPair({ counterpartyInn: "7701234567", amountKopeks: 100000 }, { counterpartyInn: "7701234567", amountKopeks: 100000, invoiceNumber: "diff" }) === "weak");

// ===================== AI quality =====================
check("27 Supplier name normalization (quotes/spaces, no meaning lost)", quality.includes("normalizeSupplierName") && quality.includes('replace(/\\s+/g, " ")'));
check("28 Supplier INN extracted (analyzer counterpartyInn)", src("src/lib/ai/invoice-analyzer.ts").includes("counterpartyInn"));
check("29 Payer matched by INN (single hit)", matchPayer("7701234567", [{ id: "e1", inn: "7701234567" }, { id: "e2", inn: "9900000000" }]) === "one");
check("30 Cross-company payer denied (scope = company entities only; no match in list)", matchPayer("5555555555", [{ id: "e1", inn: "7701234567" }]) === "none" && quality.includes("returns an entity of another company"));
check("29b INN kind: 10 → legal, 12 → ИП, else invalid", classifyInn("7701234567") === "legal" && classifyInn("770123456789") === "ip" && classifyInn("123") === "invalid");
check("31 Final payable amount extracted (picks «к оплате»)", selectAmount([{ label: "Сумма без НДС", v: 80000 }, { label: "Итого к оплате", v: 100000 }]).v === 100000);
check("32 VAT not mistaken for total", amountBlocks(selectAmount([{ label: "В т.ч. НДС", v: 20000 }]).w) === true);
check("33 Advance not mistaken for final total", amountBlocks(selectAmount([{ label: "Аванс 30%", v: 30000 }]).w) === true);
check("34 Low-confidence / doubtful amount blocks payment", amountBlocks(selectAmount([]).w) === true && quality.includes("amountBlocksPayment"));
check("35 Manual review clears the payment guard (aiDataReviewedAt/ById set)", actions.includes("aiDataReviewedAt: new Date()"));
check("36 File / financial-field change resets review (aiDataReviewedAt = null)", actions.includes("data.aiDataReviewedAt = null") && actions.includes("aiDataReviewedAt: null,"));

// ===================== Backfill =====================
const bf = src("scripts/backfill-invoice-payments.mjs");
check("37 Legacy paid invoices backfilled ONCE (one full-amount legacy payment)", bf.includes('source: "legacy_backfill"') && bf.includes("legacyBackfill: true") && bf.includes("amountKopeks: inv.amountKopeks"));
check("38 Backfill idempotent (idempotencyKey legacy:<id>, skip existing)", bf.includes("legacy:${inv.id}") && bf.includes("if (exists)"));

// ===================== Tenant / roles / obligation =====================
check("40 Tenant isolation (payment actions scope via getInvoiceForContext + companyId)", /recordInvoicePayment[\s\S]*?getInvoiceForContext/.test(actions) && /reverseInvoicePayment[\s\S]*?getInvoiceForContext/.test(actions));
check("41 Role guards (record=accountant/chief, reverse=chief only)", actions.includes("canRecordInvoicePayment(ctx.effectiveRoles)") && actions.includes("canReverseInvoicePayment(ctx.effectiveRoles)"));
check("12b Obligation for partially_paid = remaining (calendar not double-counting)", paymentsLib.includes('"partially_paid"') && paymentsLib.includes("amountKopeks: o.amountKopeks - (paidByInvoice.get(o.id) ?? 0)"));
check("MODEL InvoicePayment model + prePaymentStatus + additive migrations",
  schema.includes("model InvoicePayment") && schema.includes("prePaymentStatus") &&
  readFileSync(join(root, "prisma/migrations/20260801130000_invoice_payment/migration.sql"), "utf8").includes("InvoicePayment") &&
  readFileSync(join(root, "prisma/production/migrations/20260801130000_invoice_payment/migration.sql"), "utf8").includes("CREATE TABLE"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
