// Invoice "AI data review" set: the accountant/owner verifies the AI-extracted
// invoice fields ("Данные счёта") and a LOW-confidence invoice cannot be paid
// until they do. Pure mirrors of the shipped predicates (no DB, no network) plus
// static source guards proving the server enforces the guard and never leaks raw
// AI content. Also regression guards on invoices / OFD / sales / balances / audit.
// npm run pilot:invoice-ai-review
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- pure mirrors of src/lib/invoices.ts + actions.ts (kept in sync with source) ----
const isLowConfidence = (c) => c !== "high" && c !== "medium";
// Owner is strategic read-only — only the accounting contour reviews (chief expands
// to accountant in effectiveRoles).
const canReviewInvoiceData = (roles) => roles.includes("accountant");
const digits = (v) => { if (!v) return null; const d = String(v).replace(/\D+/g, ""); return d || null; };
function parseInvoiceWarnings(raw) {
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj?.warnings)) return [];
    return [...new Set(obj.warnings.filter((x) => typeof x === "string" && x.trim() !== "").map((s) => s.trim()))].slice(0, 20);
  } catch { return []; }
}
// PAID excluded (paid financial data is immutable); approved-unpaid statuses whose
// financial change invalidates the approval.
const REVIEW_DATA_STATUSES = ["draft", "needs_review", "needs_correction", "approved_by_regional", "approved_by_chief_accountant", "approved_by_owner"];
const APPROVED_UNPAID = ["approved_by_regional", "approved_by_chief_accountant", "approved_by_owner"];

// Financial fingerprint mirror — MUST match invoiceFinancialFingerprint in source.
const fpNorm = (v) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const fpDay = (d) => (d ? d.toISOString().slice(0, 10) : "");
function invoiceFingerprint(s) {
  const parts = [
    fpNorm(s.counterpartyName), fpNorm(s.counterpartyInn), fpNorm(s.counterpartyKpp),
    fpNorm(s.counterpartyBankName), fpNorm(s.counterpartyBankBik), fpNorm(s.counterpartyAccount), fpNorm(s.counterpartyCorrAccount),
    fpNorm(s.payerName), fpNorm(s.payerInn), fpNorm(s.payerKpp),
    String(s.amountKopeks ?? 0), fpNorm(s.invoiceNumber), fpDay(s.invoiceDate), fpDay(s.dueDate),
    fpNorm(s.subject), fpNorm(s.legalEntityId),
  ];
  return createHash("sha256").update(parts.join("")).digest("hex");
}
// Critical payment fields for the medium-confidence guard.
const hasCriticalGap = (inv) => {
  const e = (s) => !s || String(s).trim() === "";
  return e(inv.counterpartyName) || e(inv.counterpartyInn) || inv.amountKopeks <= 0 || e(inv.payerName) || e(inv.counterpartyBankBik) || e(inv.counterpartyAccount);
};
// invoicePaymentBlockedReason mirror (returns a short code or null).
function paymentBlockedReason(inv) {
  if (inv.amountKopeks <= 0) return "amount";
  if (inv.approvedDataFingerprint && inv.approvedDataFingerprint !== inv.currentFingerprint) return "fingerprint";
  const reviewed = Boolean(inv.aiDataReviewedAt);
  if (isLowConfidence(inv.confidence) && !reviewed) return "low_review";
  if (inv.confidence === "medium" && !reviewed && hasCriticalGap(inv)) return "medium_gap";
  return null;
}
// A well-formed critical-field baseline (present values, positive amount).
const baseInv = () => ({ counterpartyName: "ООО Ромашка", counterpartyInn: "7701234567", amountKopeks: 100000, payerName: "ООО Наша", counterpartyBankBik: "044525225", counterpartyAccount: "40702810000000000001" });

function main() {
  // ---- INVOICE-AI-FIELDS (extraction/normalization helpers) ----
  check("INVOICE-AI-FIELDS1 low/null/unknown confidence → low", isLowConfidence("low") && isLowConfidence(null) && isLowConfidence(undefined) && isLowConfidence("weird"));
  check("INVOICE-AI-FIELDS2 medium/high confidence → not low", !isLowConfidence("medium") && !isLowConfidence("high"));
  check("INVOICE-AI-FIELDS3 requisites soft-normalized to digits", digits(" 7701 234567 ") === "7701234567" && digits("БИК044525225") === "044525225" && digits("4070-2810/00") === "4070281000");
  check("INVOICE-AI-FIELDS4 empty / no-digit requisite → null", digits("") === null && digits(null) === null && digits("—") === null);
  check("INVOICE-AI-FIELDS5 warnings parsed from raw blob (trimmed, deduped)", JSON.stringify(parseInvoiceWarnings(JSON.stringify({ warnings: [" Проверьте ИНН ", "Проверьте ИНН", "Сумма не найдена"] }))) === JSON.stringify(["Проверьте ИНН", "Сумма не найдена"]));
  check("INVOICE-AI-FIELDS6 malformed / non-array warnings → [] (never throws)", parseInvoiceWarnings("{bad json").length === 0 && parseInvoiceWarnings(JSON.stringify({ warnings: "x" })).length === 0 && parseInvoiceWarnings(null).length === 0);
  check("INVOICE-AI-FIELDS7 only warnings surfaced — no prompt/other keys leak", (() => {
    const blob = JSON.stringify({ warnings: ["A"], prompt: "SECRET SYSTEM PROMPT", rawModelText: "confidential", apiKey: "sk-123" });
    const out = JSON.stringify(parseInvoiceWarnings(blob));
    return out === JSON.stringify(["A"]) && !out.includes("SECRET") && !out.includes("sk-123") && !out.includes("confidential");
  })());

  // ---- INVOICE-AI-PAYMENT (server pay guard — behavioural, mirrors the source) ----
  const fp = invoiceFingerprint(baseInv());
  check("INVOICE-AI-PAYMENT1 low confidence + not reviewed → blocked", paymentBlockedReason({ ...baseInv(), confidence: "low", aiDataReviewedAt: null, approvedDataFingerprint: fp, currentFingerprint: fp }) === "low_review");
  check("INVOICE-AI-PAYMENT2 low confidence + reviewed → allowed (all else ok)", paymentBlockedReason({ ...baseInv(), confidence: "low", aiDataReviewedAt: new Date(), approvedDataFingerprint: fp, currentFingerprint: fp }) === null);
  check("INVOICE-AI-PAYMENT3 medium with CRITICAL gap (empty ИНН) + not reviewed → blocked", paymentBlockedReason({ ...baseInv(), counterpartyInn: "", confidence: "medium", aiDataReviewedAt: null, approvedDataFingerprint: null, currentFingerprint: fp }) === "medium_gap");
  check("INVOICE-AI-PAYMENT3b medium with all critical fields present → NOT blocked", paymentBlockedReason({ ...baseInv(), confidence: "medium", aiDataReviewedAt: null, approvedDataFingerprint: null, currentFingerprint: fp }) === null);
  check("INVOICE-AI-PAYMENT3c medium + critical gap but REVIEWED → allowed", paymentBlockedReason({ ...baseInv(), counterpartyInn: "", confidence: "medium", aiDataReviewedAt: new Date(), approvedDataFingerprint: null, currentFingerprint: fp }) === null);
  check("INVOICE-AI-PAYMENT4 high confidence → never blocked by confidence", paymentBlockedReason({ ...baseInv(), confidence: "high", aiDataReviewedAt: null, approvedDataFingerprint: fp, currentFingerprint: fp }) === null);
  check("INVOICE-AI-PAYMENT5 non-positive amount → blocked", paymentBlockedReason({ ...baseInv(), amountKopeks: 0, confidence: "high", aiDataReviewedAt: new Date(), approvedDataFingerprint: null, currentFingerprint: fp }) === "amount");

  // ---- INVOICE-AI-VERSION (fingerprint = approved data ties to paid data) ----
  check("INVOICE-AI-VERSION1 fingerprint changes when amount changes", invoiceFingerprint({ ...baseInv() }) !== invoiceFingerprint({ ...baseInv(), amountKopeks: 100001 }));
  check("INVOICE-AI-VERSION2 fingerprint changes when counterparty account changes", invoiceFingerprint({ ...baseInv() }) !== invoiceFingerprint({ ...baseInv(), counterpartyAccount: "40702810000000000002" }));
  check("INVOICE-AI-VERSION3 fingerprint STABLE across whitespace/case/formatting", invoiceFingerprint({ ...baseInv() }) === invoiceFingerprint({ ...baseInv(), counterpartyName: "  ооо   РОМАШКА " }));
  check("INVOICE-AI-VERSION4 approved fingerprint mismatch → pay blocked (data changed after approval)", paymentBlockedReason({ ...baseInv(), confidence: "high", aiDataReviewedAt: new Date(), approvedDataFingerprint: fp, currentFingerprint: invoiceFingerprint({ ...baseInv(), amountKopeks: 999 }) }) === "fingerprint");
  check("INVOICE-AI-VERSION5 matching fingerprint → not blocked by version", paymentBlockedReason({ ...baseInv(), confidence: "high", aiDataReviewedAt: new Date(), approvedDataFingerprint: fp, currentFingerprint: fp }) === null);
  check("INVOICE-AI-VERSION6 legacy approval (null fingerprint) is never blocked by version", paymentBlockedReason({ ...baseInv(), confidence: "high", aiDataReviewedAt: new Date(), approvedDataFingerprint: null, currentFingerprint: fp }) === null);

  // ---- INVOICE-AI-ROLE (who may review the data) ----
  check("INVOICE-AI-ROLE1 accountant may review", canReviewInvoiceData(["accountant"]) === true);
  check("INVOICE-AI-ROLE2 chief accountant may review (expands to accountant in effectiveRoles)", canReviewInvoiceData(["accountant", "chief_accountant"]) === true);
  check("INVOICE-AI-ROLE3 owner may NOT review (strategic read-only)", canReviewInvoiceData(["owner"]) === false);
  check("INVOICE-AI-ROLE4 manager / regional / GD / marketer may NOT review", !canReviewInvoiceData(["manager"]) && !canReviewInvoiceData(["regional_director"]) && !canReviewInvoiceData(["general_director"]) && !canReviewInvoiceData(["marketer"]));

  // ---- Static: server action enforcement (src/app/(app)/invoices/actions.ts) ----
  const actions = src("../src/app/(app)/invoices/actions.ts");
  check("INVOICE-AI-AUDIT1 review action stamps reviewer + writes audit 'invoice.ai_data_reviewed'", actions.includes("reviewInvoiceData") && actions.includes("aiDataReviewedAt: new Date()") && actions.includes("aiDataReviewedById: ctx.user.id") && actions.includes('action: "invoice.ai_data_reviewed"'));
  check("S1 reviewInvoiceData is gated by role (canReviewInvoiceData) + scope (getInvoiceForContext)", /reviewInvoiceData[\s\S]*canReviewInvoiceData\(ctx\.effectiveRoles\)[\s\S]*getInvoiceForContext\(ctx, invoiceId\)/.test(actions));
  check("S2 pay guard delegates to the shared invoicePaymentBlockedReason (single source, UI-shared)", actions.includes('if (action === "pay")') && actions.includes("invoicePaymentBlockedReason({") && actions.includes("approvedDataFingerprint: existing.approvedDataFingerprint"));
  check("S2b approve captures the approved-data fingerprint", actions.includes('if (action === "approve")') && actions.includes("data.approvedDataFingerprint = invoiceFinancialFingerprint(invoiceFinancialSnapshot(existing))"));
  check("S3 editing an approved invoice's financial data INVALIDATES the approval (→ needs_review, fingerprint cleared)", actions.includes("const invalidateApproval = changed") && actions.includes('data.status = "needs_review"') && actions.includes("data.approvedDataFingerprint = null") && actions.includes('action: "invoice.approval_invalidated"'));
  check("S3b review RESET server-side on any financial change (updateInvoice + saveAndResubmit + file replace)", (() => {
    const upd = actions.slice(actions.indexOf("export async function updateInvoice"), actions.indexOf("function digits"));
    return upd.includes("data.aiDataReviewedAt = null") && actions.includes('action: "invoice.ai_review_invalidated"') && actions.includes("// A replaced document may change the invoice content");
  })());
  check("S3c PAID invoice financial fields are immutable (server error, view still allowed)", actions.includes('existing.status === "paid" && changed') && actions.includes("Оплаченный счёт: сумму, контрагента, плательщика, юрлицо и банковские реквизиты изменять нельзя."));
  check("S4 requisites digits-normalized + payer/subject saved on review", actions.includes("counterpartyInn: digits(") && actions.includes("payerName: str(formData") && actions.includes('subject: str(formData, "subject")'));
  check("S4b financial-change audit masks accounts (last 4 only) — no full account in audit", actions.includes("function maskAccount") && /account:\s*\{\s*from:\s*maskAccount/.test(actions) && actions.includes("invoiceChangeMetadata"));
  check("S5 review restricted to non-terminal, non-paid statuses (rejected/canceled/paid excluded)", (() => {
    const libSrc = src("../src/lib/invoices.ts");
    const i = libSrc.indexOf("export const INVOICE_REVIEW_DATA_STATUSES");
    const block = libSrc.slice(i, libSrc.indexOf("]", i));
    return actions.includes("INVOICE_REVIEW_DATA_STATUSES") && REVIEW_DATA_STATUSES.every((s) => !["rejected", "canceled", "paid"].includes(s)) && !block.includes('"paid"');
  })());

  // ---- Static: detail page wiring (src/app/(app)/invoices/[id]/page.tsx) ----
  const page = src("../src/app/(app)/invoices/[id]/page.tsx");
  check("S6 page renders the «Данные счёта» review block", page.includes("<InvoiceDataReview") && page.includes("canReview={canReviewData}"));
  check("S7 page hides pay when payBlocked, computed from the SHARED server guard", /availableActions[\s\S]*filter\([\s\S]*a === "pay" && payBlocked/.test(page) && page.includes("invoicePaymentBlockedReason({") && page.includes("const payBlocked = Boolean(payBlockReason)"));
  check("S8 page passes parsed warnings (never the raw blob) to the block", page.includes("parseInvoiceWarnings(invoice.rawExtractedJson)"));

  // ---- INVOICE-AI-UI + security (component) ----
  const ui = src("../src/app/(app)/invoices/[id]/_components/InvoiceDataReview.tsx");
  const uiFields = ["counterpartyName", "counterpartyInn", "counterpartyKpp", "payerName", "subject", "counterpartyBankName", "counterpartyBankBik", "counterpartyAccount", "counterpartyCorrAccount", "invoiceNumber", "invoiceDate", "dueDate", "amount"];
  check("INVOICE-AI-UI1 block shows all extracted fields, confidence, warnings + save button", uiFields.every((f) => ui.includes(`name="${f}"`) || ui.includes(f)) && ui.includes("Уверенность ИИ") && ui.includes("Предупреждения ИИ") && ui.includes("Сохранить данные счёта"));
  check("INVOICE-AI-UI2 grouped 2-col form, dark-safe neutral tokens, no raw JSON/secrets", ui.includes("md:grid-cols-2") && ui.includes("<Group") && !ui.includes("rawExtractedJson") && !/JSON\.stringify/.test(ui) && !/process\.env|OPENAI_API|sk-[a-z0-9]/i.test(ui));
  check("INVOICE-AI-UI3 read-only projection for non-review roles (no editable inputs leaked)", ui.includes("canReview ?") && ui.includes("ReadField"));

  // ---- lib exports present ----
  const lib = src("../src/lib/invoices.ts");
  check("S9 helpers exported from invoices.ts (incl. fingerprint + shared pay guard)", lib.includes("export function isLowConfidence") && lib.includes("export function canReviewInvoiceData") && lib.includes("export function invoiceFinancialFingerprint") && lib.includes("export function invoicePaymentBlockedReason") && lib.includes("export const INVOICE_REVIEW_DATA_STATUSES"));
  check("S9b owner removed from canReviewInvoiceData (accountant contour only)", (() => { const s = lib.indexOf("export function canReviewInvoiceData"); const b = lib.slice(s, s + 320); return b.includes('has(roles, "accountant")') && !b.includes('"owner"'); })());

  // ---- Migration is non-destructive (ADD COLUMN only) ----
  for (const [tag, p] of [["dev", "../prisma/migrations/20260720000000_add_invoice_ai_review_fields/migration.sql"], ["prod", "../prisma/production/migrations/20260720000000_add_invoice_ai_review_fields/migration.sql"]]) {
    const sql = src(p);
    const destructive = /\b(DROP|TRUNCATE|DELETE)\b/i.test(sql);
    const adds = (col) => new RegExp(`ADD COLUMN\\s+"${col}"`).test(sql);
    check(`S10 ${tag} migration adds nullable columns only — no DROP/TRUNCATE/DELETE`, adds("aiDataReviewedAt") && adds("aiDataReviewedById") && adds("aiDataReviewNote") && !destructive);
  }
  for (const [tag, p] of [["dev", "../prisma/schema.prisma"], ["prod", "../prisma/production/schema.prisma"]]) {
    const schema = src(p);
    check(`S11 ${tag} schema declares the 3 nullable review fields on Invoice`, schema.includes("aiDataReviewedAt   DateTime?") && schema.includes("aiDataReviewedById String?") && schema.includes("aiDataReviewNote   String?"));
    check(`S11b ${tag} schema declares Invoice.approvedDataFingerprint (nullable)`, schema.includes("approvedDataFingerprint String?"));
  }
  // New non-destructive migration (approval fingerprint + refund v2 payment fields).
  for (const [tag, p] of [["dev", "../prisma/migrations/20260721000000_add_financial_approval_and_refund_v2_payment/migration.sql"], ["prod", "../prisma/production/migrations/20260721000000_add_financial_approval_and_refund_v2_payment/migration.sql"]]) {
    const sql = src(p);
    // Ignore `--` comment lines (the header prose mentions DROP/TRUNCATE/DELETE).
    const sqlCode = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const destructive = /\b(DROP|TRUNCATE|DELETE)\b/i.test(sqlCode);
    const adds = (col) => new RegExp(`ADD COLUMN\\s+"${col}"`).test(sql);
    check(`S12 ${tag} migration adds nullable columns only — no DROP/TRUNCATE/DELETE`, adds("approvedDataFingerprint") && adds("legalEntityId") && adds("paidByUserId") && adds("paymentComment") && adds("calculationInputHash") && !destructive);
  }

  // ---- REGRESSION guards (feature must not disturb neighbours) ----
  check("REGRESSION-INVOICE1 send_to_review still NOT gated by AI confidence", actions.includes("AI confidence is NOT a gate"));
  check("REGRESSION-INVOICE2 updateInvoice still author/scope/strategic-readonly gated (unchanged)", actions.includes("canMutateOperationalRecords(ctx.effectiveRoles)") && actions.includes("Редактировать поля счёта может только его автор"));
  check("REGRESSION-OFD1 OFD / Taxcom management loader untouched (still present)", src("../src/lib/analytics/ofd-management.ts").includes("loadOfdManagementOverview"));
  check("REGRESSION-SALES1 no manual-sales resurrection — invoices page has no «Продажи» entry", !page.includes("Продажи") && !ui.includes("Продажи"));
  check("REGRESSION-BALANCES1 cash-balances math untouched (loadClubCashBalances present)", src("../src/lib/cash-collections.ts").includes("export async function loadClubCashBalances"));
  check("REGRESSION-AUDIT1 recordAudit contract unchanged (action: string)", src("../src/lib/access.ts").includes("export async function recordAudit") && /action:\s*string/.test(src("../src/lib/access.ts")));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
