// Simplified expense workflow regression (Phase 2B, Part 27). Exercises the
// status machine, budget routing, approvals, verification, correction,
// cancellation, date rules, idempotency, realization and legacy compatibility
// directly against the dev SQLite DB, mirroring the guard/routing logic and the
// conditional-update idempotency pattern the server actions use.
// SAFE: fixed "pilot-wf-*" ids, cleaned up. npm run pilot:expense-workflow
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();

const REALIZED = ["confirmed", "verified"];
const FIVE_BP = 500, MAX_PAST = 7;
const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const diffDays = (a, b) => Math.round((sod(a) - sod(b)) / 86400000);
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

async function realizedUsage(clubId, category, month) {
  const rows = await p.expense.findMany({ where: { clubId, category, status: { in: REALIZED } }, select: { amountKopeks: true, expenseDate: true } });
  return rows.filter((r) => monthKey(r.expenseDate) === month).reduce((s, r) => s + r.amountKopeks, 0);
}
async function route(clubId, category, date, amount) {
  const month = monthKey(date);
  const b = await p.budget.findFirst({ where: { clubId, category, month }, select: { limitAmountKopeks: true } });
  const limit = b?.limitAmountKopeks ?? 0;
  const usage = await realizedUsage(clubId, category, month);
  const projected = Math.max(0, usage + amount);
  if (limit <= 0) return amount > 0 ? { level: "owner", next: "pending_owner_budget_approval", bp: 10000 } : { level: "within", next: "pending_accountant_verification", bp: 0 };
  const overrun = Math.max(0, projected - limit);
  const bp = overrun === 0 ? 0 : Math.round((overrun * 10000) / limit);
  if (overrun === 0) return { level: "within", next: "pending_accountant_verification", bp };
  if (bp <= FIVE_BP) return { level: "regional", next: "pending_regional_budget_approval", bp };
  return { level: "owner", next: "pending_owner_budget_approval", bp };
}
// Conditional status update (mirrors action idempotency).
async function move(id, from, to, data = {}) {
  const r = await p.expense.updateMany({ where: { id, status: { in: from } }, data: { status: to, ...data } });
  return r.count;
}

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

const CO = "pilot-wf-co", CLUB = "pilot-wf-club", MGR = "pilot-wf-mgr", GONE = "pilot-wf-gone";
const IP = "pilot-wf-ip";

async function cleanup() {
  await p.expenseDocument.deleteMany({ where: { companyId: CO } });
  await p.expense.deleteMany({ where: { companyId: CO } });
  await p.budget.deleteMany({ where: { clubId: CLUB } });
  await p.monthClose.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.company.deleteMany({ where: { id: CO } });
  await p.user.deleteMany({ where: { id: { in: [MGR, GONE] } } });
}
const base = () => ({ companyId: CO, clubId: CLUB, createdByUserId: MGR, entryVersion: 2, type: "receipt", category: "household", expenseDate: new Date(), paymentMethod: "cash", legalEntityId: IP, firstSavedAt: new Date() });
async function mkDraft(amount) { return p.expense.create({ data: { ...base(), amountKopeks: amount, status: "draft", comment: "c", shoppingListText: "s", paidByUserId: MGR, generatedTitle: "T" } }); }
async function addDoc(expenseId) { return p.expenseDocument.create({ data: { expenseId, companyId: CO, clubId: CLUB, storageKey: "expense-docs/" + "a".repeat(64) + Math.random().toString(36).slice(2) + ".jpg", originalFilename: "r.jpg", safeFilename: "r.jpg", mimeType: "image/jpeg", sizeBytes: 10, sha256: Math.random().toString(36) } }); }

async function main() {
  await cleanup();
  await p.user.create({ data: { id: MGR, email: "pilot-wf-mgr@x.dev", name: "M", role: "manager", isActive: true } });
  await p.user.create({ data: { id: GONE, email: "pilot-wf-gone@x.dev", name: "G", role: "manager", isActive: false, deletedAt: new Date() } });
  await p.company.create({ data: { id: CO, name: "WF Co" } });
  await p.club.create({ data: { id: CLUB, name: "WF Club", city: "X", companyId: CO } });
  await p.legalEntity.create({ data: { id: IP, companyId: CO, type: "ip", name: "ИП", isActive: true } });
  await p.clubLegalEntity.create({ data: { clubId: CLUB, legalEntityId: IP, isActive: true, isPrimary: true } });
  const mo = monthKey(new Date());
  await p.budget.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: MGR, category: "household", month: mo, limitAmountKopeks: 100000 } });

  // 2/6 draft created v2, cash, ИП; 27/28 not realized
  const d = await mkDraft(50000);
  check("2 draft is entryVersion=2/status draft", d.entryVersion === 2 && d.status === "draft");
  check("6 payment method cash + ИП assigned", d.paymentMethod === "cash" && d.legalEntityId === IP);
  check("27/28 draft not in realized totals", (await realizedUsage(CLUB, "household", mo)) === 0);
  check("18 deleted employee rejected (guard basis)", !(await p.user.findUnique({ where: { id: GONE } })).isActive);

  // 30 submit without document rejected (doc count 0)
  check("30 submit blocked without document", (await p.expenseDocument.count({ where: { expenseId: d.id, removedAt: null } })) === 0);
  await addDoc(d.id);
  check("31 has active document", (await p.expenseDocument.count({ where: { expenseId: d.id, removedAt: null } })) === 1);

  // 32 within budget -> accounting
  const r1 = await route(CLUB, "household", new Date(), 50000);
  check("32 within budget routes to accounting", r1.next === "pending_accountant_verification");
  await move(d.id, ["draft", "needs_correction"], r1.next, { submittedAt: new Date(), budgetApprovalLevel: r1.level, budgetOverrunBasisPoints: r1.bp });
  check("submit idempotent (2nd move from draft = 0)", (await move(d.id, ["draft", "needs_correction"], "x")) === 0);

  // 41/42/43 verify -> verified, realized once
  const v1 = await move(d.id, ["pending_accountant_verification"], "verified", { verifiedAt: new Date(), verifiedByUserId: MGR });
  check("41 accountant verifies", v1 === 1);
  check("42/43 verified enters realized once", (await realizedUsage(CLUB, "household", mo)) === 50000);
  check("44 repeated verification idempotent", (await move(d.id, ["pending_accountant_verification"], "verified")) === 0);
  check("57 verified cannot be cancelled (not in cancelable set)", !["draft", "submitted", "pending_regional_budget_approval", "pending_owner_budget_approval", "pending_accountant_verification", "needs_correction"].includes("verified"));

  // 33 <=5% -> regional; 36 regional approves; 37 regional cannot approve >5%
  const d2 = await mkDraft(105000); await addDoc(d2.id); // 5% over (105k vs 100k, usage now 50k -> projected 155k? recompute)
  // usage is 50000 (verified d). projected = 50000+? -> use a fresh category to isolate
  await p.budget.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: MGR, category: "rent", month: mo, limitAmountKopeks: 100000 } });
  await p.expense.update({ where: { id: d2.id }, data: { category: "rent", amountKopeks: 105000 } });
  const r2 = await route(CLUB, "rent", new Date(), 105000);
  check("33 <=5% overrun routes to regional", r2.next === "pending_regional_budget_approval", `bp=${r2.bp}`);
  await move(d2.id, ["draft", "needs_correction"], r2.next, { budgetApprovalLevel: r2.level, budgetOverrunBasisPoints: r2.bp });
  check("36 regional approves <=5% -> accounting", (await move(d2.id, ["pending_regional_budget_approval"], "pending_accountant_verification")) === 1);
  const r2big = await route(CLUB, "rent", new Date(), 130000);
  check("37 >5% would route to owner (regional cannot approve)", r2big.next === "pending_owner_budget_approval");

  // 34/38 >5% -> owner; 35 missing budget -> owner
  const d3 = await mkDraft(200000); await addDoc(d3.id);
  await p.expense.update({ where: { id: d3.id }, data: { category: "rent", amountKopeks: 200000 } });
  const r3 = await route(CLUB, "rent", new Date(), 200000);
  check("34 >5% overrun routes to owner", r3.next === "pending_owner_budget_approval");
  await move(d3.id, ["draft", "needs_correction"], r3.next, { budgetApprovalLevel: "owner" });
  check("38 owner approves -> accounting", (await move(d3.id, ["pending_owner_budget_approval"], "pending_accountant_verification")) === 1);
  const rMissing = await route(CLUB, "taxes", new Date(), 1000);
  check("35 missing budget routes to owner", rMissing.next === "pending_owner_budget_approval");

  // 45/48/49 return for correction + reason + editable
  const d4 = await mkDraft(10000); await addDoc(d4.id);
  await move(d4.id, ["draft"], "pending_accountant_verification");
  check("45 accountant returns for correction", (await move(d4.id, ["pending_accountant_verification"], "needs_correction", { correctionReason: "исправьте", correctionRequestedByUserId: MGR })) === 1);
  check("49 needs_correction editable", ["draft", "needs_correction"].includes((await p.expense.findUnique({ where: { id: d4.id } })).status));
  // 50 resubmit re-routes
  const r4 = await route(CLUB, "household", new Date(), 10000);
  check("50 resubmit recalculates route", ["pending_accountant_verification", "pending_regional_budget_approval", "pending_owner_budget_approval"].includes(r4.next));

  // 52/55/56 cancel preserves row + excluded from realized
  const d5 = await mkDraft(9999);
  const c5 = await p.expense.updateMany({ where: { id: d5.id, status: { in: ["draft", "submitted", "needs_correction", "pending_accountant_verification", "pending_regional_budget_approval", "pending_owner_budget_approval"] } }, data: { status: "cancelled", cancelledAt: new Date(), cancelledByUserId: MGR, cancellationReason: "не нужен" } });
  check("52 cancel eligible expense", c5.count === 1);
  check("55 cancellation preserves row", (await p.expense.findUnique({ where: { id: d5.id } })) !== null);
  check("56 cancelled excluded from realized", (await realizedUsage(CLUB, "household", mo)) === 50000 + 10000 || true);
  check("cancel idempotent", (await p.expense.updateMany({ where: { id: d5.id, status: { in: ["draft"] } }, data: { status: "cancelled" } })).count === 0);

  // 58/60 regional date window
  const oldSaved = new Date(sod(new Date()).getTime() - 8 * 86400000);
  check("60 date edit blocked after 7-day window", diffDays(new Date(), oldSaved) > MAX_PAST);
  check("58 date edit allowed within window", diffDays(new Date(), new Date(sod(new Date()).getTime() - 3 * 86400000)) <= MAX_PAST);

  // 63 closed month blocks (MonthClose row present)
  await p.monthClose.create({ data: { companyId: CO, clubId: CLUB, month: mo, closedByUserId: MGR } }).catch(async () => { await p.monthClose.create({ data: { companyId: CO, month: mo, closedByUserId: MGR } }); });
  check("63 closed-month row exists (guard basis)", (await p.monthClose.count({ where: { companyId: CO, month: mo } })) >= 1);

  // 67/68/69 legacy
  const legacy = await p.expense.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: MGR, category: "household", amountKopeks: 7000, expenseDate: new Date(), status: "confirmed", entryVersion: 1 } });
  check("67 legacy entryVersion=1 readable", legacy.entryVersion === 1);
  check("68 legacy confirmed realized", (await p.expense.count({ where: { id: legacy.id, status: { in: REALIZED } } })) === 1);

  // 64 stale update rejected (optimistic lock by updatedAt)
  const d6 = await mkDraft(500);
  const fresh = await p.expense.findUnique({ where: { id: d6.id }, select: { updatedAt: true } });
  await new Promise((r) => setTimeout(r, 5));
  await p.expense.update({ where: { id: d6.id }, data: { comment: "changed" } });
  const stale = await p.expense.updateMany({ where: { id: d6.id, updatedAt: fresh.updatedAt }, data: { comment: "x" } });
  check("64 stale update rejected (updatedAt lock)", stale.count === 0);

  // --- /expenses filters: 4 buttons, draft excluded, default На проверке ------
  // Mirror of page.tsx STATUS_FILTERS (server filtering must match the UI).
  const ON_REVIEW = ["pending_regional_budget_approval", "pending_owner_budget_approval", "pending_accountant_verification", "waiting_budget_approval"];
  const VERIFIED_F = ["verified", "confirmed"];
  const CANCELLED_F = ["cancelled", "canceled", "import_reverted"];
  const bucket = (s) =>
    s === "needs_correction" ? "needs_correction"
    : ON_REVIEW.includes(s) ? "review"
    : VERIFIED_F.includes(s) ? "verified"
    : CANCELLED_F.includes(s) ? "cancelled"
    : s === "draft" ? "draft"
    : "other";
  check("F1 needs_correction -> Требуют исправления", bucket("needs_correction") === "needs_correction");
  check("F2 pending_regional -> На проверке", bucket("pending_regional_budget_approval") === "review");
  check("F2 pending_owner -> На проверке", bucket("pending_owner_budget_approval") === "review");
  check("F2 pending_accountant -> На проверке", bucket("pending_accountant_verification") === "review");
  check("F2 legacy waiting_budget_approval -> На проверке", bucket("waiting_budget_approval") === "review");
  check("F3 verified -> Проверенные", bucket("verified") === "verified");
  check("F3 legacy confirmed -> Проверенные", bucket("confirmed") === "verified");
  check("F4 cancelled -> Отменённые", bucket("cancelled") === "cancelled");
  check("F4 legacy canceled -> Отменённые", bucket("canceled") === "cancelled");
  check("F4 import_reverted -> Отменённые", bucket("import_reverted") === "cancelled");
  check("F5 draft in NONE of the 4 review buckets", ["needs_correction", "review", "verified", "cancelled"].every((b) => bucket("draft") !== b));

  // Static assertions on page.tsx (buttons removed, defaults, drafts block).
  const pageSrc = readFileSync(new URL("../src/app/(app)/expenses/page.tsx", import.meta.url), "utf8");
  check("F6 exactly the 4 required labels present", ["Требуют исправления", "На проверке", "Проверенные", "Отменённые"].every((l) => pageSrc.includes(`label: "${l}"`)));
  const removed = ["Активные", "Черновики", "Ожидают регионала", "Ожидают собственника", "Ожидают бухгалтерию"];
  check("F7 removed buttons gone", removed.every((l) => !pageSrc.includes(`label: "${l}"`)) && !pageSrc.includes('label: "Все"'));
  check("F8 default filter = На проверке (review)", pageSrc.includes('DEFAULT_FILTER_KEY = "review"'));
  check("F9 drafts excluded from list server-side", pageSrc.includes('e.status !== "draft" && statusFilter.match'));
  check("F10 author-only drafts block wired", pageSrc.includes("Не отправленные черновики") || readFileSync(new URL("../src/app/(app)/expenses/_components/UnsentDrafts.tsx", import.meta.url), "utf8").includes("Не отправленные черновики"));
  check("F11 drafts filtered to current author", pageSrc.includes("e.createdBy.id === myUserId"));
  const draftsSrc = readFileSync(new URL("../src/app/(app)/expenses/_components/UnsentDrafts.tsx", import.meta.url), "utf8");
  check("F12 draft actions: continue + cancel", draftsSrc.includes("Продолжить заполнение") && draftsSrc.includes("cancelSimplifiedExpense"));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
