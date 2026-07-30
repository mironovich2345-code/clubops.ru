// Simplified cash-expense workflow regression (Part 22). Exercises the financial/
// date/budget/ИП/title/category invariants the services enforce (lib/expense-
// simplified, expense-title, expense-categories, budgets) directly against the
// dev SQLite DB, mirroring the service logic. SAFE: fixed "pilot-exp-*" ids,
// cleaned up. npm run pilot:expenses-simplified
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();

// --- mirrors of the pure service logic ------------------------------------
const REALIZED = ["confirmed", "verified"];
const FIVE_PCT_BP = 500;
const MAX_PAST_DAYS = 7; // regional date-correction window only
const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const diffDays = (a, b) => Math.round((sod(a) - sod(b)) / 86400000);
// Mirror of validateExpenseBusinessDate: any day of the CURRENT month up to today.
function validateDate(expenseDate, now = new Date()) {
  const d = sod(expenseDate);
  const today = sod(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  if (d.getTime() > today.getTime()) return "future";
  if (d.getTime() < monthStart.getTime()) return "past_month";
  return "ok";
}
function buildTitle(cat, list) {
  const clean = (s) => String(s ?? "").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
  const c = clean(cat) || "Расход";
  const first = clean((list ?? "").split(/\r?\n/).find((l) => clean(l).length > 0) ?? "");
  if (!first) return c.slice(0, 120);
  const sum = first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
  return `${c}: ${sum}`.slice(0, 120);
}
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

const CO = "pilot-exp-co", CLUB = "pilot-exp-club", CLUB2 = "pilot-exp-club2", MGR = "pilot-exp-mgr", GONE = "pilot-exp-gone", FOREIGN = "pilot-exp-foreign";
const OOO = "pilot-exp-ooo", IP1 = "pilot-exp-ip1", IP2 = "pilot-exp-ip2";

async function cleanup() {
  await p.expense.deleteMany({ where: { companyId: CO } });
  await p.budget.deleteMany({ where: { clubId: CLUB } });
  await p.monthClose.deleteMany({ where: { clubId: CLUB } }).catch(() => {});
  await p.expenseCategory.deleteMany({ where: { key: { startsWith: "pilot-exp-cat" } } });
  await p.clubUserAccess.deleteMany({ where: { userId: { in: [MGR, GONE, FOREIGN, "pilot-exp-reg"] } } });
  await p.company.deleteMany({ where: { id: CO } });
  await p.user.deleteMany({ where: { id: { in: [MGR, GONE, FOREIGN, "pilot-exp-reg"] } } });
}

// Employees selectable as "Кто оплатил" for a Club — mirrors simple/page.tsx.
async function selectableEmployees(clubId, companyId) {
  return p.user.findMany({
    where: {
      isActive: true, deletedAt: null,
      OR: [{ clubRoles: { some: { clubId } } }, { companyAccess: { some: { companyId } } }],
    },
    select: { id: true }, orderBy: { name: "asc" },
  });
}
const defaultPaidBy = (list, currentUserId) => (list.some((e) => e.id === currentUserId) ? currentUserId : "");

async function realizedUsage(clubId, category, month) {
  const rows = await p.expense.findMany({ where: { clubId, category, status: { in: REALIZED } }, select: { amountKopeks: true, expenseDate: true } });
  return rows.filter((r) => monthKey(r.expenseDate) === month).reduce((s, r) => s + r.amountKopeks, 0);
}
async function routeBudget(clubId, category, date, amount) {
  const month = monthKey(date);
  const b = await p.budget.findFirst({ where: { clubId, category, month }, select: { limitAmountKopeks: true } });
  const limit = b?.limitAmountKopeks ?? 0;
  const usage = await realizedUsage(clubId, category, month);
  const projected = Math.max(0, usage + amount);
  if (limit <= 0) return amount > 0 ? { level: "owner", bp: 10000 } : { level: "within", bp: 0 };
  const overrun = Math.max(0, projected - limit);
  const bp = overrun === 0 ? 0 : Math.round((overrun * 10000) / limit);
  const level = overrun === 0 ? "within" : bp <= FIVE_PCT_BP ? "regional" : "owner";
  return { level, bp };
}
async function activeIp(clubId) {
  const rows = await p.clubLegalEntity.findMany({ where: { clubId, isActive: true, legalEntity: { isActive: true, type: { in: ["ip", "ИП"] } } }, select: { legalEntityId: true } });
  if (rows.length === 0) return { ok: false, reason: "none" };
  if (rows.length > 1) return { ok: false, reason: "multiple" };
  return { ok: true, id: rows[0].legalEntityId };
}

async function main() {
  await cleanup();
  const today = new Date();
  await p.user.create({ data: { id: MGR, email: "pilot-exp-mgr@x.dev", name: "Менеджер", role: "manager", isActive: true } });
  await p.user.create({ data: { id: GONE, email: "pilot-exp-gone@x.dev", name: "Удалён", role: "manager", isActive: false, deletedAt: new Date() } });
  await p.user.create({ data: { id: FOREIGN, email: "pilot-exp-foreign@x.dev", name: "Чужой клуб", role: "manager", isActive: true } });
  await p.company.create({ data: { id: CO, name: "Exp Co" } });
  await p.club.create({ data: { id: CLUB, name: "Exp Club", city: "X", companyId: CO } });
  await p.club.create({ data: { id: CLUB2, name: "Exp Club 2", city: "Y", companyId: CO } });
  // MGR has club-level access to CLUB; FOREIGN only to CLUB2 (via a club role).
  await p.clubUserAccess.create({ data: { clubId: CLUB, userId: MGR, role: "manager" } });
  await p.clubUserAccess.create({ data: { clubId: CLUB2, userId: FOREIGN, role: "manager" } });
  await p.legalEntity.create({ data: { id: OOO, companyId: CO, type: "ooo", name: "ООО", isActive: true } });
  await p.legalEntity.create({ data: { id: IP1, companyId: CO, type: "ip", name: "ИП1", isActive: true } });
  await p.legalEntity.create({ data: { id: IP2, companyId: CO, type: "ip", name: "ИП2", isActive: true } });
  await p.clubLegalEntity.create({ data: { clubId: CLUB, legalEntityId: OOO, isActive: true, isPrimary: true } });
  await p.clubLegalEntity.create({ data: { clubId: CLUB, legalEntityId: IP1, isActive: true, isPrimary: true } });

  // --- Title (Part 4) ---
  check("3 title = категория: краткое содержание", buildTitle("Хозрасходы", "бумага, мыло, пакеты") === "Хозрасходы: бумага, мыло, пакеты");
  check("3 title strips HTML/script chars", !buildTitle("Расход", "<script>alert(1)</script>").includes("<"));
  check("3 title truncates long list", buildTitle("Кат", "a".repeat(200)).length <= 120);

  // --- Date rules: any day of the CURRENT month up to today ---
  const NOW = new Date(2026, 6, 20); // fixed: 2026-07-20 (deterministic)
  check("EXPENSE-DATE1 первое число текущего месяца принимается", validateDate(new Date(2026, 6, 1), NOW) === "ok");
  check("EXPENSE-DATE2 дата внутри месяца старше 7 дней принимается", validateDate(new Date(2026, 6, 2), NOW) === "ok" && diffDays(NOW, new Date(2026, 6, 2)) > 7);
  check("today accepted", validateDate(NOW, NOW) === "ok");
  check("EXPENSE-DATE3 будущая дата отклоняется", validateDate(new Date(2026, 6, 21), NOW) === "future");
  check("EXPENSE-DATE4 прошлый месяц отклоняется", validateDate(new Date(2026, 5, 30), NOW) === "past_month");
  const srcExpSimp = readFileSync(new URL("../src/lib/expense-simplified.ts", import.meta.url), "utf8");
  check("EXPENSE-DATE6 текст ошибки без «7 дней»; диапазон = текущий месяц", srcExpSimp.includes('EXPENSE_DATE_RANGE_ERROR = "Расход можно занести только за текущий месяц и не позже сегодняшнего дня."') && !/validateExpenseBusinessDate[\s\S]{0,320}7 дней/.test(srcExpSimp) && /validateExpenseBusinessDate[\s\S]{0,320}monthStart/.test(srcExpSimp));

  // --- Active ИП (Part 6) ---
  check("15 single active ИП resolved", (await activeIp(CLUB)).id === IP1);
  await p.clubLegalEntity.create({ data: { clubId: CLUB, legalEntityId: IP2, isActive: true, isPrimary: false } });
  check("17 multiple active ИП blocks", (await activeIp(CLUB)).reason === "multiple");
  await p.clubLegalEntity.updateMany({ where: { clubId: CLUB, legalEntityId: IP2 }, data: { isActive: false } });
  await p.clubLegalEntity.updateMany({ where: { clubId: CLUB, legalEntityId: IP1 }, data: { isActive: false } });
  check("16 no active ИП blocks", (await activeIp(CLUB)).reason === "none");
  await p.clubLegalEntity.updateMany({ where: { clubId: CLUB, legalEntityId: IP1 }, data: { isActive: true } });

  // --- Budget routing (Part 12) ---
  const cat = "household";
  const mo = monthKey(today);
  await p.budget.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: MGR, category: cat, month: mo, limitAmountKopeks: 100000 } });
  check("28 within budget -> accounting", (await routeBudget(CLUB, cat, today, 50000)).level === "within");
  check("29 <=5% overrun -> regional", (await routeBudget(CLUB, cat, today, 105000)).level === "regional"); // 5% over
  check("31/32 >5% overrun -> owner", (await routeBudget(CLUB, cat, today, 120000)).level === "owner"); // 20% over
  check("missing/zero budget + amount -> owner", (await routeBudget(CLUB, "taxes", today, 1000)).level === "owner");

  // --- Realized-status counting (Part 19) ---
  const mkExp = (status, amount) => p.expense.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: MGR, category: cat, amountKopeks: amount, expenseDate: today, status, entryVersion: status === "verified" ? 2 : 1 } });
  await mkExp("verified", 30000);
  await mkExp("confirmed", 20000); // legacy realized
  await mkExp("draft", 9999);
  await mkExp("submitted", 8888);
  await mkExp("pending_accountant_verification", 7777);
  await mkExp("needs_correction", 6666);
  await mkExp("cancelled", 5555);
  const usage = await realizedUsage(CLUB, cat, mo);
  check("43 verified counts once; 42/others excluded", usage === 30000 + 20000, `usage=${usage}`);

  // --- Categories (Part 8) ---
  const catRow = await p.expenseCategory.create({ data: { key: "pilot-exp-cat1", name: "Тест", isActive: true } });
  await p.expenseCategoryNameHistory.create({ data: { categoryId: catRow.id, name: "Тест", changedByUserId: MGR } });
  // rename preserves history + key unchanged
  await p.expenseCategory.update({ where: { id: catRow.id }, data: { name: "Тест2" } });
  await p.expenseCategoryNameHistory.create({ data: { categoryId: catRow.id, name: "Тест2", changedByUserId: MGR } });
  const hist = await p.expenseCategoryNameHistory.count({ where: { categoryId: catRow.id } });
  check("48/preserve rename history", hist === 2 && (await p.expenseCategory.findUnique({ where: { id: catRow.id } })).key === "pilot-exp-cat1");
  // disable -> unavailable for new; historical key still resolvable
  await p.expenseCategory.update({ where: { id: catRow.id }, data: { isActive: false } });
  const active = await p.expenseCategory.findFirst({ where: { key: "pilot-exp-cat1", isActive: true } });
  check("50 disabled category unavailable for new expense", active === null);
  check("51 historical category still displayable", (await p.expenseCategory.findUnique({ where: { key: "pilot-exp-cat1" } })).name === "Тест2");

  // --- paidBy (Part 5/7): deleted user cannot be selected ---
  const goneUser = await p.user.findUnique({ where: { id: GONE }, select: { isActive: true, deletedAt: true } });
  check("14 deleted/inactive user cannot be paidBy", !(goneUser.isActive && !goneUser.deletedAt));

  // --- Legacy readability (Part 17) ---
  const legacy = await p.expense.findFirst({ where: { clubId: CLUB, status: "confirmed" } });
  check("52 legacy entryVersion=1 remains readable", legacy && legacy.entryVersion === 1);

  // === Simplify cash form: comment / payer / cash-forbidden categories ========
  const CASH_FORBIDDEN = ["taxes", "rent", "builders"];
  const isCashForbidden = (k) => CASH_FORBIDDEN.includes(k);
  const form = readFileSync(new URL("../src/app/(app)/expenses/simple/SimpleExpenseForm.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/(app)/expenses/simple/page.tsx", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../src/app/(app)/expenses/simplified-actions.ts", import.meta.url), "utf8");
  const expensesLib = readFileSync(new URL("../src/lib/expenses.ts", import.meta.url), "utf8");

  // --- Comment / shopping list ---
  check("C1 shopping-list field removed from the form", !form.includes('name="shoppingList"'));
  check("C2 comment field kept + placeholder", form.includes('name="comment"') && form.includes("Например: ручки, мыло и т. д."));
  check("C2 server requires comment", actions.includes("if (!comment) return { error: E.COMMENT }"));
  check("C3 server no longer requires shopping list", !actions.includes("E.SHOPPING") && !actions.includes('formData.get("shoppingList")'));
  // legacy expense with a filled shopping list still opens/displays
  const legShop = await p.expense.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: MGR, category: "household", amountKopeks: 1234, expenseDate: today, status: "confirmed", entryVersion: 1, shoppingListText: "бумага, мыло" } });
  check("C3 legacy expense with shopping list still readable", (await p.expense.findUnique({ where: { id: legShop.id } })).shoppingListText === "бумага, мыло");
  check("C5 legacy shoppingListText column NOT dropped (still queryable)", (await p.expense.count({ where: { shoppingListText: { not: null } } })) >= 1);

  // --- Кто оплатил (payer = server-side current user) ---
  check("P1 no employee <select name=paidByUserId> in the form", !form.includes('name="paidByUserId"'));
  check("P1 read-only 'Кто оплатил' info shown", form.includes("Кто оплатил") && form.includes("payerName"));
  check("P1 page passes payerName from server user", page.includes("payerName") && page.includes("ctx.user.id"));
  check("P2 server sets paidBy = ctx.user.id", actions.includes("const paidByUserId = ctx.user.id"));
  check("P2 parseFields does not read client paidByUserId", !actions.includes('formData.get("paidByUserId")'));
  check("P3 update does not change paidBy or shoppingListText", !actions.includes("paidByUserId: fields.paidByUserId") && !actions.includes("shoppingListText: fields.shoppingListText"));
  check("P4 audit records actual payer", actions.includes("metadata: { amountKopeks: fields.amountKopeks, category: fields.categoryKey, paidByUserId }"));

  // --- Cash-forbidden categories (taxes/rent/builders) ---
  check("K1 forbidden set uses stable keys", isCashForbidden("taxes") && isCashForbidden("rent") && isCashForbidden("builders"));
  check("K1 allowed category not forbidden", !isCashForbidden("household") && !isCashForbidden("other"));
  check("K2 cash form filters out forbidden keys", page.includes("isCashForbiddenCategory") && page.includes("cashCategories"));
  check("K2 server rejects forbidden on create (parseFields)", actions.includes("if (isCashForbiddenCategory(categoryKey)) return { error: E.CATEGORY_NOT_CASH }"));
  check("K2 server rejects forbidden on submit (v2)", actions.includes('expense.entryVersion === 2 && isCashForbiddenCategory(expense.category)'));
  check("K3 forbidden categories still in the shared catalog", ["taxes", "rent", "builders"].every((k) => expensesLib.includes(`key: "${k}"`)));
  check("K3 catalog list is not globally disabled by this rule", expensesLib.includes("CASH_FORBIDDEN_CATEGORY_KEYS") && expensesLib.includes('"taxes", "rent", "builders"'));
  // old expenses with a forbidden category still display + count in analytics
  const oldTax = await p.expense.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: MGR, category: "taxes", amountKopeks: 9000, expenseDate: today, status: "confirmed", entryVersion: 1 } });
  check("K4 old expense with 'taxes' still stored/displayable", (await p.expense.findUnique({ where: { id: oldTax.id } })).category === "taxes");
  check("K4 forbidden-category expenses still counted in realized usage", (await realizedUsage(CLUB, "taxes", mo)) === 9000);
  check("K5 chief accountant still manages the catalog", (function canManage(roles) { return roles.includes("chief_accountant"); })(["chief_accountant"]) && !(function canManage(roles) { return roles.includes("chief_accountant"); })(["manager"]));

  // --- Documents / preview + two-column layout (static) ---
  check("D1 two-column desktop layout (lg:grid-cols-2)", form.includes("lg:grid-cols-2"));
  check("D2 image preview via object URL", form.includes("URL.createObjectURL") && form.includes("<img src={f.url}"));
  check("D3 object URLs revoked (no leak)", form.includes("URL.revokeObjectURL"));
  check("D4 PDF shown as a compact card", form.includes(">PDF<"));
  check("D5 client mirrors max 3 + 10MB + formats", form.includes("MAX_FILES = 3") && form.includes("MAX_FILE_BYTES = 10 * 1024 * 1024") && form.includes('accept="image/jpeg,image/png,image/webp,application/pdf"'));
  check("D6 min 1 doc gate + no-duplicate-draft guard kept", form.includes("files.length < 1") && form.includes("draftIdRef"));

  // --- Pilot routing: manager expense → regional first (Stage 3) ------------
  // Routing is by the CREATOR's role (read from the DB), not the budget: a
  // manager's expense ALWAYS goes to the regional director; a regional's OWN
  // expense goes straight to accounting (no self-approval); if the club has NO
  // active regional director, a manager's submit is BLOCKED (never routed to
  // accounting/owner) and the status + documents stay unchanged.
  const REG = "pilot-exp-reg";
  await p.user.create({ data: { id: REG, email: "pilot-exp-reg@x.dev", name: "РД", role: "regional_director", isActive: true } });
  await p.clubUserAccess.create({ data: { clubId: CLUB, userId: REG, role: "regional_director" } });
  // Mirror of the submitExpense routing override (createdBy role + active-regional).
  const creatorIsRegional = (uid, clubId) => p.clubUserAccess.count({ where: { userId: uid, clubId, role: "regional_director" } }).then((n) => n > 0);
  const hasActiveRegional = async (companyId, clubId) =>
    (await p.clubUserAccess.count({ where: { clubId, role: "regional_director", user: { isActive: true } } })) > 0 ||
    (await p.companyUserAccess.count({ where: { companyId, role: "regional_director", user: { isActive: true } } })) > 0;
  const routeReview = async (createdByUserId, clubId, companyId) => {
    if (await creatorIsRegional(createdByUserId, clubId)) return { ok: true, next: "pending_accountant_verification" };
    if (await hasActiveRegional(companyId, clubId)) return { ok: true, next: "pending_regional_budget_approval" };
    return { ok: false, error: "no_regional" };
  };
  // Mirror of the action's control flow: block-BEFORE-update, else compare-and-set.
  const simulateSubmit = async (expenseId) => {
    const e = await p.expense.findUnique({ where: { id: expenseId }, select: { createdByUserId: true, clubId: true, companyId: true } });
    const r = await routeReview(e.createdByUserId, e.clubId, e.companyId);
    if (!r.ok) return { ok: false, error: r.error };
    await p.expense.updateMany({ where: { id: expenseId, status: { in: ["draft", "needs_correction"] } }, data: { status: r.next } });
    return { ok: true };
  };
  // CLUB has an active regional (REG); CLUB2 has none.
  check("R1 manager expense (within budget) still routes to regional", (await routeReview(MGR, CLUB, CO)).next === "pending_regional_budget_approval");
  check("R2 manager expense (any budget) never skips regional to accounting", (await routeReview(MGR, CLUB, CO)).next !== "pending_accountant_verification");
  check("R3 regional's OWN expense goes straight to accounting", (await routeReview(REG, CLUB, CO)).next === "pending_accountant_verification");
  check("R4 manager expense with NO active regional is BLOCKED (not routed to accounting)", (await routeReview(FOREIGN, CLUB2, CO)).ok === false);
  // Guard: a regional never approves their own expense (defense for legacy rows).
  const selfApprove = (createdByUserId, actorId, status) => !(createdByUserId && createdByUserId === actorId) && status === "pending_regional_budget_approval";
  check("R5 regional CAN approve a manager's pending_regional expense", selfApprove(MGR, REG, "pending_regional_budget_approval") === true);
  check("R6 regional CANNOT approve their OWN expense", selfApprove(REG, REG, "pending_regional_budget_approval") === false);
  // Static: the action routes by creator role, blocks (not fallbacks) with no regional.
  check("R7 submit routes by creator role (userHasClubRole regional_director)", actions.includes('userHasClubRole(expense.createdByUserId, expense.clubId, ["regional_director"])'));
  check("R8 submit no longer uses the budget route.nextStatus", !actions.includes("status: route.nextStatus"));
  check("R9 submit uses hasActiveRegionalApproverForClub", actions.includes("hasActiveRegionalApproverForClub(expense.companyId, expense.clubId)"));
  check("R10 budget analytics fields still stored on submit", actions.includes("budgetOverrunKopeks: route.overrunKopeks") && actions.includes("budgetApprovalLevel: route.level"));
  const simplifiedLib = readFileSync(new URL("../src/lib/expense-simplified.ts", import.meta.url), "utf8");
  check("R11 canApproveRegionalExpense blocks self-approval", simplifiedLib.includes("e.createdByUserId === a.userId) return false"));
  const cashBalLib = readFileSync(new URL("../src/lib/cash-balances.ts", import.meta.url), "utf8");
  const budgetsLib = readFileSync(new URL("../src/lib/budgets.ts", import.meta.url), "utf8");
  check("EXPENSE-DATE5 закрытый месяц блокирует создание/изменение (monthClosedError сохранён) + понятный текст", actions.includes("monthClosedError") && actions.includes('MONTH_CLOSED: "Месяц закрыт. Добавление или изменение расходов недоступно."') && /createSimplifiedExpenseDraft[\s\S]{0,900}monthClosedError/.test(actions) && /updateSimplifiedExpense[\s\S]{0,1200}monthClosedError/.test(actions));
  check("EXPENSE-DATE7 pending cash-расход уменьшает факт-остаток ИП, но не confirmedCosts/прибыль (математика не изменена; статусы из общего src/lib/expense-status.ts)", (() => { const statusLib = readFileSync(new URL("../src/lib/expense-status.ts", import.meta.url), "utf8"); return cashBalLib.includes("IP_EXPENSE_PENDING_STATUSES: readonly string[] = EXPENSE_CASH_PENDING_STATUSES") && cashBalLib.includes("IP_EXPENSE_APPROVED_STATUSES: readonly string[] = EXPENSE_VERIFIED_STATUSES") && /EXPENSE_REVIEW_STATUSES[\s\S]*?"submitted"/.test(statusLib) && statusLib.includes('EXPENSE_VERIFIED_STATUSES = ["verified", "confirmed"]') && /EXPENSE_REALIZED_STATUSES\s*=\s*\[\s*"confirmed",\s*"verified"\s*\]/.test(budgetsLib); })());

  // --- No-regional block: status + documents unchanged (R12–R20) -----------
  // FOREIGN is a manager of CLUB2, which has NO regional director.
  const d1 = await p.expense.create({ data: { companyId: CO, clubId: CLUB2, createdByUserId: FOREIGN, category: "household", amountKopeks: 3000, expenseDate: today, status: "draft", entryVersion: 2 } });
  const s1 = await simulateSubmit(d1.id);
  check("R12 manager submit with no regional → blocked", s1.ok === false && s1.error === "no_regional");
  check("R13 blocked submit leaves the status as draft", (await p.expense.findUnique({ where: { id: d1.id } })).status === "draft");
  const d2 = await p.expense.create({ data: { companyId: CO, clubId: CLUB2, createdByUserId: FOREIGN, category: "household", amountKopeks: 4000, expenseDate: today, status: "needs_correction", entryVersion: 2 } });
  const s2 = await simulateSubmit(d2.id);
  check("R14 manager resubmit (needs_correction) with no regional → blocked", s2.ok === false);
  check("R15 blocked resubmit leaves the status as needs_correction", (await p.expense.findUnique({ where: { id: d2.id } })).status === "needs_correction");
  const acctQueue = await p.expense.count({ where: { companyId: CO, clubId: CLUB2, status: "pending_accountant_verification" } });
  check("R16 blocked expense never appears in the accountant queue", acctQueue === 0);
  // Assign a regional to CLUB2, then the SAME draft submits successfully to regional.
  await p.clubUserAccess.create({ data: { clubId: CLUB2, userId: REG, role: "regional_director" } });
  const s3 = await simulateSubmit(d1.id);
  check("R17 after a regional is assigned, the same expense routes to regional", s3.ok === true && (await p.expense.findUnique({ where: { id: d1.id } })).status === "pending_regional_budget_approval");
  // Regional-created expense on CLUB (REG is regional there) still goes straight to accounting.
  const d3 = await p.expense.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: REG, category: "household", amountKopeks: 5000, expenseDate: today, status: "draft", entryVersion: 2 } });
  const s4 = await simulateSubmit(d3.id);
  check("R18 regional-created expense still goes straight to accounting", s4.ok === true && (await p.expense.findUnique({ where: { id: d3.id } })).status === "pending_accountant_verification");
  // Static: the else branch BLOCKS with the exact error (no accounting fallback).
  check("R19 no-regional path blocks with E.NO_REGIONAL (no accounting fallback)", actions.includes("return { ok: false, error: E.NO_REGIONAL }"));
  check("R20 blocked-submit message is the approved Russian text", actions.includes("Для клуба не назначен региональный директор. Обратитесь к администратору."));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
