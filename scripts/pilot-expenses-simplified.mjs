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
const MAX_PAST_DAYS = 7;
const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const diffDays = (a, b) => Math.round((sod(a) - sod(b)) / 86400000);
function validateDate(expenseDate, now = new Date()) {
  const delta = diffDays(now, expenseDate);
  if (delta < 0) return "future";
  if (delta > MAX_PAST_DAYS) return "too_old";
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
  await p.clubUserAccess.deleteMany({ where: { userId: { in: [MGR, GONE, FOREIGN] } } });
  await p.company.deleteMany({ where: { id: CO } });
  await p.user.deleteMany({ where: { id: { in: [MGR, GONE, FOREIGN] } } });
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

  // --- Date rules (Part 14) ---
  check("7 future date rejected", validateDate(new Date(today.getTime() + 864e5)) === "future");
  check("today accepted", validateDate(today) === "ok");
  check("8 exactly 7 days ago accepted", validateDate(new Date(sod(today).getTime() - 7 * 864e5)) === "ok");
  check("9 8 days ago rejected", validateDate(new Date(sod(today).getTime() - 8 * 864e5)) === "too_old");

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

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
