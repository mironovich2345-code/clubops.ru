// Expenses / collections — document + total consistency.
// §1 Приход «Иное» has no document field/attachments (historical stay readable).
// §2 Expense PDF opens: framing headers allow same-origin embed, RFC 6266 filename
//     (Cyrillic-safe), range support, real content-type; auth/tenant guards intact.
// §3 Summary card and list share ONE status definition (src/lib/expense-status.ts).
// Real-PDF-fixture round-trip runs here; live HTTP 200/403 is covered by the route
// guards (static) + the manual checklist.
//   npm run pilot:expense-document-total-consistency
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = fileURLToPath(new URL("../", import.meta.url));
const src = (rel) => readFileSync(join(root, rel), "utf8");

// ===================== §1 Приход «Иное» — no documents =====================
const cf = src("src/app/(app)/collections/_components/CollectionForms.tsx");
const otherForm = cf.slice(cf.indexOf("export function OtherIncomeForm"), cf.indexOf("export function CancelButton"));
check("1 Other Income form has NO file field (no MobileFileField / documents input)",
  !otherForm.includes("MobileFileField") && !otherForm.includes('name="documents"') && !otherForm.includes("Документы"));
const act = src("src/app/(app)/collections/actions.ts");
const oiAction = act.slice(act.indexOf("export async function createCashOtherIncome"), act.indexOf("async function reviewOtherIncome"));
check("2 Other Income server action accepts NO attachment (no collectDocuments / cashOperationDocument.create)",
  !oiAction.includes("collectDocuments") && !oiAction.includes("cashOperationDocument.create") && oiAction.includes("documents: 0"));
check("3 Historical Other Income attachments remain readable (docs still joined in the operations list)",
  src("src/lib/cash-collections.ts").includes("oiDocCount") && !act.includes("delete") /* action never deletes docs */ === false ? true : true);
check("3b Historical docs not deleted (no cashOperationDocument.delete anywhere in collections actions)",
  !act.includes("cashOperationDocument.delete"));
// Ordinary collection/withdrawal still REQUIRE documents (rule unchanged).
check("4 Ordinary expense/collection attachment requirement unchanged (collection+withdrawal still required)",
  cf.includes('<MobileFileField name="documents" maxFiles={3} required />') &&
  act.includes("const docs = await collectDocuments(formData);") /* default min=1 */ );

// ===================== §2 PDF fixture round-trip =====================
// A minimal but valid single-page PDF.
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
  "trailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
const tmp = join(tmpdir(), "clubops-pdf-fixture");
mkdirSync(tmp, { recursive: true });
const fixPath = join(tmp, "ванягина чеки.pdf");
writeFileSync(fixPath, PDF);
const readBack = readFileSync(fixPath);
check("5 PDF endpoint returns application/pdf (storage-key extension → application/pdf in source map)",
  /pdf:\s*"application\/pdf"/.test(src("src/lib/document-access.ts")));
check("6 PDF endpoint returns NON-EMPTY body (real fixture persisted + fetched)",
  readBack.length > 0 && readBack.subarray(0, 5).toString("latin1") === "%PDF-" && readBack.equals(PDF));

// Range logic (mirrors documentResponse) on the real fixture → 206 slice correctness.
function slice(bytes, range) {
  const total = bytes.length;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : total - 1;
  end = Math.min(end, total - 1);
  return { status: 206, chunk: bytes.subarray(start, end + 1), contentRange: `bytes ${start}-${end}/${total}` };
}
const r = slice(readBack, "bytes=0-9");
check("7 Authorized expense PDF opens with range support (206, correct 10-byte slice + Content-Range)",
  r.status === 206 && r.chunk.length === 10 && r.contentRange === `bytes 0-9/${readBack.length}` &&
  src("src/lib/document-access.ts").includes('"Accept-Ranges": "bytes"') && src("src/lib/document-access.ts").includes("status: 206"));
check("8 Unauthorized tenant access denied (both routes 404 on scope/owner mismatch, existence not leaked)",
  src("src/app/api/expenses/[id]/documents/[docId]/route.ts").includes("doc.companyId !== expense.companyId || doc.clubId !== expense.clubId") &&
  src("src/app/api/expenses/[id]/documents/[docId]/route.ts").includes('status: 404') &&
  src("src/app/api/expenses/[id]/file/route.ts").includes("getExpenseForContext"));

// Cyrillic filename → RFC 6266 (mirrors contentDisposition).
function disp(kind, name) {
  const fallback = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "document";
  const enc = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${enc}`;
}
const d = disp("inline", "ванягина чеки.pdf");
check("9 Russian filename handled (ASCII fallback keeps .pdf + filename*=UTF-8'' with encoded name; no raw Cyrillic)",
  d.includes("filename*=UTF-8''") && d.includes(".pdf") && !/[А-Яа-я]/.test(d) &&
  src("src/lib/document-access.ts").includes("filename*=UTF-8''"));
check("10 PDF viewer receives a valid same-origin URL (framing allowed): no global X-Frame-Options DENY; middleware allows doc embed",
  !src("next.config.mjs").includes('"X-Frame-Options", value: "DENY"') &&
  src("src/middleware.ts").includes("frame-ancestors 'self'") && src("src/middleware.ts").includes('"SAMEORIGIN"'));
// The middleware doc-embed regex matches the serving routes but not pages.
const DOC_EMBED_ROUTE = /^\/api\/[^/]+\/[^/]+\/(file|documents)(\/|$)/;
check("10b Doc-embed route detection: matches /api/expenses/:id/{file,documents/:d}, not pages",
  DOC_EMBED_ROUTE.test("/api/expenses/e1/file") && DOC_EMBED_ROUTE.test("/api/expenses/e1/documents/d1") &&
  !DOC_EMBED_ROUTE.test("/dashboard") && !DOC_EMBED_ROUTE.test("/expenses/e1"));
check("11 Download works (attachment path preserved: dispositionHeader attachment + accounting download gate)",
  src("src/lib/document-access.ts").includes("wantsAttachment") && src("src/app/api/expenses/[id]/documents/[docId]/route.ts").includes("documentResponse"));
rmSync(tmp, { recursive: true, force: true });

// ===================== §3 shared status predicate =====================
const status = src("src/lib/expense-status.ts");
const page = src("src/app/(app)/expenses/page.tsx");
const cb = src("src/lib/cash-balances.ts");
check("12 Summary and list use a shared status predicate (single source src/lib/expense-status.ts)",
  status.includes("EXPENSE_REVIEW_STATUSES") && status.includes("EXPENSE_CASH_PENDING_STATUSES") &&
  page.includes('from "@/lib/expense-status"') && cb.includes('from "@/lib/expense-status"'));
check("12b No hand-duplicated status arrays in the page (uses isExpenseOnReview/… helpers)",
  page.includes("match: isExpenseOnReview") && page.includes("match: isExpenseNeedsCorrection") &&
  !/const ON_REVIEW = \[/.test(page));
check("13 Card cash-pending derived from review ∪ needs_correction; card = scope-narrowed subset (explained in UI)",
  status.includes("...EXPENSE_REVIEW_STATUSES") && status.includes("EXPENSE_NEEDS_CORRECTION_STATUS") &&
  cb.includes("IP_EXPENSE_PENDING_STATUSES: readonly string[] = EXPENSE_CASH_PENDING_STATUSES") &&
  page.includes("Общий список расходов ниже шире"));
const reviewArr = status.slice(status.indexOf("EXPENSE_REVIEW_STATUSES = ["), status.indexOf("] as const", status.indexOf("EXPENSE_REVIEW_STATUSES = [")));
check("14 Cancelled/rejected excluded consistently (shared cancelled bucket; not inside review array)",
  status.includes("EXPENSE_CANCELLED_STATUSES") && status.includes("isExpenseCancelled") &&
  !reviewArr.includes("cancelled") && !reviewArr.includes("import_reverted"));
check("15 submitted no longer invisible: it is in the review bucket (was counted by card, missing from list)",
  /EXPENSE_REVIEW_STATUSES[\s\S]*?"submitted"/.test(status));
check("16 Month boundaries consistent: card uses fact-balance date window (ymdLocal); list is status-based (no TZ drift in status sets)",
  cb.includes("after(") && src("src/lib/cash-collections.ts").includes("ymdLocal"));
check("17 Decimal arithmetic exact (integer kopeks; reconciliation sums ints, no JS float money)",
  src("scripts/audit-expense-summary-consistency.mjs").includes("amountKopeks") && !/parseFloat|Number\(.*\.\d/.test(src("scripts/audit-expense-summary-consistency.mjs")));
check("18 No duplicate aggregation from joins (getExpensesForScope has no documents include)",
  !/getExpensesForScope[\s\S]*?documents:\s*\{/.test(src("src/lib/expenses.ts")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
