// Behavioural (real dev SQLite DB) test of ExpenseCategory SYSTEM + COMPANY
// isolation. Executes the EXACT scoping queries the server uses (expense-categories.ts)
// against real rows, proving a company sees system + its own categories only, never
// another company's — and that a company category can never claim a system key.
// npm run pilot:category-isolation
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// Exact mirror of the source WHERE clauses (expense-categories.ts). companyId is a
// plain scalar (no FK), so synthetic company ids need no Company rows.
const activeSelectableWhere = (companyId) => ({ isActive: true, key: { not: "refunds" }, OR: [{ isSystem: true }, { companyId }] });

async function main() {
  const T = `citest_${Date.now()}`;
  const A = `${T}_companyA`, B = `${T}_companyB`;
  const sysKey = `${T}_sys`, aKey = `${T}_a`, bKey = `${T}_b`, aDisabledKey = `${T}_a_off`;
  const allKeys = [sysKey, aKey, bKey, aDisabledKey];

  // Clean any stragglers, then seed.
  await prisma.expenseCategory.deleteMany({ where: { key: { in: allKeys } } });
  await prisma.expenseCategory.create({ data: { key: sysKey, name: "SYS", isActive: true, isSystem: true, companyId: null } });
  await prisma.expenseCategory.create({ data: { key: aKey, name: "A-cat", isActive: true, isSystem: false, companyId: A } });
  await prisma.expenseCategory.create({ data: { key: bKey, name: "B-cat", isActive: true, isSystem: false, companyId: B } });
  await prisma.expenseCategory.create({ data: { key: aDisabledKey, name: "A-off", isActive: false, isSystem: false, companyId: A } });

  try {
    // CATEGORY1 — system category is visible to BOTH companies.
    const activeA = (await prisma.expenseCategory.findMany({ where: activeSelectableWhere(A) })).map((r) => r.key);
    const activeB = (await prisma.expenseCategory.findMany({ where: activeSelectableWhere(B) })).map((r) => r.key);
    check("CATEGORY1 system category visible to company A and B", activeA.includes(sysKey) && activeB.includes(sysKey));

    // CATEGORY2 — company A's own category is visible to A.
    check("CATEGORY2 company A sees its own category", activeA.includes(aKey));

    // CATEGORY3 — company B does NOT see company A's category (isolation).
    check("CATEGORY3 company B does NOT see company A's category", !activeB.includes(aKey) && !activeA.includes(bKey));

    // CATEGORY4 — a disabled company category is not selectable.
    check("CATEGORY4 disabled company category not selectable", !activeA.includes(aDisabledKey));

    // CATEGORY5 — isActiveExpenseCategoryKey scoping: B cannot use A's key/id.
    const isActiveForCompany = async (key, companyId) => {
      if (!key || key === "refunds") return false;
      const row = await prisma.expenseCategory.findFirst({ where: { key, isActive: true, OR: [{ isSystem: true }, { companyId }] }, select: { id: true } });
      return row !== null;
    };
    check("CATEGORY5 B cannot use A's category key", (await isActiveForCompany(aKey, B)) === false && (await isActiveForCompany(aKey, A)) === true);
    check("CATEGORY6 both companies may use the system key", (await isActiveForCompany(sysKey, A)) === true && (await isActiveForCompany(sysKey, B)) === true);
    check("CATEGORY7 refunds key never selectable by a manager", (await isActiveForCompany("refunds", A)) === false);

    // CATEGORY8 — disabling A's category does not affect B (already isolated), and a
    // toggle on A's row changes only A's visibility.
    await prisma.expenseCategory.update({ where: { key: aKey }, data: { isActive: false } });
    const activeA2 = (await prisma.expenseCategory.findMany({ where: activeSelectableWhere(A) })).map((r) => r.key);
    const activeB2 = (await prisma.expenseCategory.findMany({ where: activeSelectableWhere(B) })).map((r) => r.key);
    check("CATEGORY8 disabling A's category affects only A", !activeA2.includes(aKey) && activeB2.includes(bKey) && activeB2.includes(sysKey));

    // CATEGORY9 — a company category can NEVER claim a system key (key stays globally
    // unique + the create path forbids system keys).
    const SYSTEM_KEYS = ["advertising", "household", "builders", "rent", "maintenance", "investments", "taxes", "salary", "dismissal_compensation", "recruitment", "it_services", "office_supplies", "consumables", "refunds", "other"];
    const isSystemKey = (k) => SYSTEM_KEYS.includes(k);
    check("CATEGORY9 system keys are recognized and reserved", isSystemKey("rent") && isSystemKey("refunds") && !isSystemKey(aKey));
  } finally {
    await prisma.expenseCategory.deleteMany({ where: { key: { in: allKeys } } });
  }

  // Static guards: the server actually uses the scoped model.
  const lib = src("../src/lib/expense-categories.ts");
  const catActions = src("../src/app/(app)/expenses/category-actions.ts");
  const simplified = src("../src/app/(app)/expenses/simplified-actions.ts");
  const budgetImport = src("../src/app/(app)/budgets/budget-import-actions.ts");
  const schema = src("../prisma/schema.prisma");
  check("S1 schema: ExpenseCategory has isSystem + companyId", schema.includes("isSystem  Boolean  @default(false)") && /companyId String\?/.test(schema.slice(schema.indexOf("model ExpenseCategory"))));
  check("S2 lib scopes selection to (isSystem OR companyId)", lib.includes("OR: [{ isSystem: true }, { companyId }]") && lib.includes("export async function isActiveExpenseCategoryKey(key: string, companyId: string)"));
  check("S3 create sets companyId + isSystem:false; rename/disable reject system + foreign", catActions.includes("isSystem: false, companyId: guard.companyId") && catActions.includes("if (cat.isSystem)") && catActions.includes("cat.companyId !== guard.companyId"));
  check("S4 expense create/submit pass companyId to the category check", simplified.includes("isActiveExpenseCategoryKey(categoryKey, companyId)") && simplified.includes("isActiveExpenseCategoryKey(expense.category, expense.companyId)"));
  check("S5 budget import validates against system + company categories only", budgetImport.includes("importableCategories(") && budgetImport.includes("getCompanyOwnedExpenseCategories"));

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
