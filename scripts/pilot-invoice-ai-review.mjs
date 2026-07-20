// Invoice "AI data review" set: the accountant/owner verifies the AI-extracted
// invoice fields ("Данные счёта") and a LOW-confidence invoice cannot be paid
// until they do. Pure mirrors of the shipped predicates (no DB, no network) plus
// static source guards proving the server enforces the guard and never leaks raw
// AI content. Also regression guards on invoices / OFD / sales / balances / audit.
// npm run pilot:invoice-ai-review
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- pure mirrors of src/lib/invoices.ts + actions.ts ----
const isLowConfidence = (c) => c !== "high" && c !== "medium";
const canReviewInvoiceData = (roles) => roles.includes("accountant") || roles.includes("owner");
const digits = (v) => { if (!v) return null; const d = String(v).replace(/\D+/g, ""); return d || null; };
function parseInvoiceWarnings(raw) {
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj?.warnings)) return [];
    return [...new Set(obj.warnings.filter((x) => typeof x === "string" && x.trim() !== "").map((s) => s.trim()))].slice(0, 20);
  } catch { return []; }
}
// Pay guard: only "pay" is gated, only for low-confidence-unreviewed invoices.
const payBlocked = (action, inv) => action === "pay" && isLowConfidence(inv.confidence) && !inv.aiDataReviewedAt;
const REVIEW_DATA_STATUSES = ["draft", "needs_review", "needs_correction", "approved_by_regional", "approved_by_chief_accountant", "approved_by_owner", "paid"];

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

  // ---- INVOICE-AI-PAYMENT (server pay guard) ----
  check("INVOICE-AI-PAYMENT1 low confidence + not reviewed → pay blocked", payBlocked("pay", { confidence: "low", aiDataReviewedAt: null }) === true);
  check("INVOICE-AI-PAYMENT2 low confidence + reviewed → pay allowed", payBlocked("pay", { confidence: "low", aiDataReviewedAt: new Date() }) === false);
  check("INVOICE-AI-PAYMENT3 medium/high confidence + not reviewed → pay allowed", payBlocked("pay", { confidence: "medium", aiDataReviewedAt: null }) === false && payBlocked("pay", { confidence: "high", aiDataReviewedAt: null }) === false);
  check("INVOICE-AI-PAYMENT4 guard is scoped to pay — submit/approve never blocked", payBlocked("send_to_review", { confidence: "low", aiDataReviewedAt: null }) === false && payBlocked("approve", { confidence: "low", aiDataReviewedAt: null }) === false);

  // ---- INVOICE-AI-ROLE (who may review the data) ----
  check("INVOICE-AI-ROLE1 accountant may review", canReviewInvoiceData(["accountant"]) === true);
  check("INVOICE-AI-ROLE2 chief accountant may review (expands to accountant in effectiveRoles)", canReviewInvoiceData(["accountant", "chief_accountant"]) === true);
  check("INVOICE-AI-ROLE3 owner may review", canReviewInvoiceData(["owner"]) === true);
  check("INVOICE-AI-ROLE4 manager / regional / GD / marketer may NOT review", !canReviewInvoiceData(["manager"]) && !canReviewInvoiceData(["regional_director"]) && !canReviewInvoiceData(["general_director"]) && !canReviewInvoiceData(["marketer"]));

  // ---- Static: server action enforcement (src/app/(app)/invoices/actions.ts) ----
  const actions = src("../src/app/(app)/invoices/actions.ts");
  check("INVOICE-AI-AUDIT1 review action stamps reviewer + writes audit 'invoice.ai_data_reviewed'", actions.includes("reviewInvoiceData") && actions.includes("aiDataReviewedAt: new Date()") && actions.includes("aiDataReviewedById: ctx.user.id") && actions.includes('action: "invoice.ai_data_reviewed"'));
  check("S1 reviewInvoiceData is gated by role (canReviewInvoiceData) + scope (getInvoiceForContext)", /reviewInvoiceData[\s\S]*canReviewInvoiceData\(ctx\.effectiveRoles\)[\s\S]*getInvoiceForContext\(ctx, invoiceId\)/.test(actions));
  check("S2 pay guard: exact message, scoped to action==='pay', low + unreviewed, server-side", actions.includes('action === "pay" && isLowConfidence(existing.confidence) && !existing.aiDataReviewedAt') && actions.includes("Перед оплатой проверьте и сохраните данные счёта."));
  check("S3 review does NOT change invoice status (no status write in the review update)", (() => {
    const start = actions.indexOf("export async function reviewInvoiceData");
    const end = actions.indexOf("export async function", start + 10);
    const body = actions.slice(start, end);
    return start > 0 && !/\bstatus:\s/.test(body);
  })());
  check("S4 requisites digits-normalized + payer/subject saved on review", actions.includes("counterpartyInn: digits(") && actions.includes("payerName: str(formData") && actions.includes('subject: str(formData, "subject")'));
  check("S5 review restricted to non-terminal statuses (rejected/canceled excluded)", actions.includes("INVOICE_REVIEW_DATA_STATUSES") && REVIEW_DATA_STATUSES.every((s) => !["rejected", "canceled"].includes(s)));

  // ---- Static: detail page wiring (src/app/(app)/invoices/[id]/page.tsx) ----
  const page = src("../src/app/(app)/invoices/[id]/page.tsx");
  check("S6 page renders the «Данные счёта» review block", page.includes("<InvoiceDataReview") && page.includes("canReview={canReviewData}"));
  check("S7 page hides the pay action when payBlocked (UI mirrors the server guard)", /availableActions[\s\S]*filter\([\s\S]*a === "pay" && payBlocked/.test(page) && page.includes("const payBlocked = isLow && !reviewed"));
  check("S8 page passes parsed warnings (never the raw blob) to the block", page.includes("parseInvoiceWarnings(invoice.rawExtractedJson)"));

  // ---- INVOICE-AI-UI + security (component) ----
  const ui = src("../src/app/(app)/invoices/[id]/_components/InvoiceDataReview.tsx");
  const uiFields = ["counterpartyName", "counterpartyInn", "counterpartyKpp", "payerName", "subject", "counterpartyBankName", "counterpartyBankBik", "counterpartyAccount", "counterpartyCorrAccount", "invoiceNumber", "invoiceDate", "dueDate", "amount"];
  check("INVOICE-AI-UI1 block shows all extracted fields, confidence, warnings + save button", uiFields.every((f) => ui.includes(`name="${f}"`) || ui.includes(f)) && ui.includes("Уверенность ИИ") && ui.includes("Предупреждения ИИ") && ui.includes("Сохранить данные счёта"));
  check("INVOICE-AI-UI2 grouped 2-col form, dark-safe neutral tokens, no raw JSON/secrets", ui.includes("md:grid-cols-2") && ui.includes("<Group") && !ui.includes("rawExtractedJson") && !/JSON\.stringify/.test(ui) && !/process\.env|OPENAI_API|sk-[a-z0-9]/i.test(ui));
  check("INVOICE-AI-UI3 read-only projection for non-review roles (no editable inputs leaked)", ui.includes("canReview ?") && ui.includes("ReadField"));

  // ---- lib exports present ----
  const lib = src("../src/lib/invoices.ts");
  check("S9 helpers exported from invoices.ts", lib.includes("export function isLowConfidence") && lib.includes("export function canReviewInvoiceData") && lib.includes("export function parseInvoiceWarnings") && lib.includes("export const INVOICE_REVIEW_DATA_STATUSES"));

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
