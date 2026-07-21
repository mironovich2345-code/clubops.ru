// Plan & budget template imports + monthly-expense date + risk-closure guards.
// Pure invariants (amount parser, preview builders) + static source guards. No DB.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? `  ${x}` : ""}`); c ? pass++ : fail++; };
const rd = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

// --- Mirror of src/lib/imports/amount.ts -----------------------------------
function parseAmt(raw) {
  let s = String(raw ?? "").trim().replace(/₽|руб\.?/gi, "");
  s = s.replace(/\s/g, "");
  if (s === "") return { empty: true };
  if (!/^[\d.,]+$/.test(s)) return { error: true };
  let intStr = s, fracStr = "";
  const ls = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  if (ls !== -1) { const a = s.slice(ls + 1); if (a.length === 1 || a.length === 2) { intStr = s.slice(0, ls); fracStr = a; } }
  const id = intStr.replace(/[.,]/g, "");
  if (!/^\d+$/.test(id)) return { error: true };
  const r = Number(id) + (fracStr ? Number(`0.${fracStr}`) : 0);
  if (!Number.isFinite(r) || r < 0) return { error: true };
  return { kopeks: Math.round(r) * 100 };
}
const amt = (c) => { const p = parseAmt(c); if ("empty" in p) return { kopeks: 0 }; if ("error" in p) return { error: "Неверная сумма" }; return { kopeks: p.kopeks }; };

// --- Mirror of buildPlanPreview (core) -------------------------------------
function planPreview({ rawRows, scopeClubs, currentPlans, month }) {
  const byId = new Map(scopeClubs.map((c) => [c.id, c]));
  const byName = new Map();
  for (const c of scopeClubs) { const k = norm(c.name); byName.set(k, [...(byName.get(k) ?? []), c]); }
  const cur = new Map(currentPlans.map((p) => [p.clubId, p]));
  const rows = []; let anyError = false; const seen = new Set();
  for (const raw of rawRows) {
    const idCell = String(raw.clubIdCell ?? "").trim();
    let club = idCell ? byId.get(idCell) : undefined;
    if (!club) { const h = byName.get(norm(raw.clubNameCell)); if (h && h.length === 1) club = h[0]; }
    if (!club) { anyError = true; rows.push({ status: "error", error: "no_club" }); continue; }
    if (seen.has(club.id)) { anyError = true; rows.push({ status: "error", error: "dup" }); continue; }
    const mc = String(raw.monthCell ?? "").trim();
    if (mc && mc !== month) { anyError = true; rows.push({ status: "error", error: "month" }); continue; }
    const s = amt(raw.subsCell), p = amt(raw.ptCell);
    if ("error" in s || "error" in p) { anyError = true; rows.push({ status: "error", error: "amount" }); continue; }
    seen.add(club.id);
    const c = cur.get(club.id);
    rows.push({ clubId: club.id, newSubsKopeks: s.kopeks, newPtKopeks: p.kopeks, newTotalKopeks: s.kopeks + p.kopeks, status: c ? "update" : "create" });
  }
  return { rows, anyError };
}

// --- Mirror of buildBudgetPreview (core) -----------------------------------
function budgetPreview({ rawRows, scopeClubs, categories, currentBudgets, month }) {
  const byId = new Map(scopeClubs.map((c) => [c.id, c]));
  const catByKey = new Map(categories.map((c) => [c.key, c]));
  const catByLabel = new Map(categories.map((c) => [norm(c.label), c]));
  const curk = new Map(currentBudgets.map((b) => [`${b.clubId}::${b.category}`, b.limitKopeks]));
  const rows = []; let anyError = false; const seen = new Set();
  for (const raw of rawRows) {
    const ap = parseAmt(raw.amountCell);
    if ("empty" in ap) continue;
    const club = byId.get(String(raw.clubIdCell ?? "").trim());
    const cat = catByKey.get(String(raw.categoryCell ?? "").trim()) ?? catByLabel.get(norm(raw.categoryCell));
    if (!club) { anyError = true; rows.push({ status: "error", error: "no_club" }); continue; }
    if (!cat) { anyError = true; rows.push({ status: "error", error: "no_cat" }); continue; }
    const key = `${club.id}::${cat.key}`;
    if (seen.has(key)) { anyError = true; rows.push({ status: "error", error: "dup" }); continue; }
    if ("error" in ap) { anyError = true; rows.push({ status: "error", error: "amount" }); continue; }
    seen.add(key);
    const c = curk.get(key) ?? 0;
    rows.push({ clubId: club.id, category: cat.key, newKopeks: ap.kopeks, status: c > 0 ? "update" : "create" });
  }
  return { rows, anyError };
}

function main() {
  const amountLib = rd("src/lib/imports/amount.ts");
  const planLib = rd("src/lib/imports/plan-import.ts");
  const budgetLib = rd("src/lib/imports/budget-import.ts");
  const planActions = rd("src/app/(app)/dashboard/plan-import-actions.ts");
  const budgetActions = rd("src/app/(app)/budgets/budget-import-actions.ts");
  const planRoute = rd("src/app/api/sales-plans/template/route.ts");
  const budgetRoute = rd("src/app/api/budgets/template/route.ts");
  const planPanel = rd("src/app/(app)/dashboard/_components/PlanImportPanel.tsx");
  const budgetPanel = rd("src/app/(app)/budgets/_components/BudgetImportPanel.tsx");
  const planForm = rd("src/app/(app)/dashboard/_components/SalesPlanForm.tsx");
  const authSrc = rd("src/lib/auth.ts");
  const navSrc = rd("src/lib/navigation.ts");
  const salesPage = rd("src/app/(app)/sales/page.tsx");
  const salesReportActions = rd("src/app/(app)/sales/report-actions.ts");
  const balancesPage = rd("src/app/(app)/balances/page.tsx");
  const auditDoc = rd("docs/audits/finance-accounting-logic-audit.md");

  const clubs = [{ id: "c1", name: "Клуб 1", city: "Москва" }, { id: "c2", name: "Клуб 2", city: "Казань" }];
  const cats = [{ key: "advertising", label: "Реклама" }, { key: "rent", label: "Аренда" }];

  // ---- Amount parser ----
  check("PLAN-IMPORT6/BUDGET-IMPORT5 парсер принимает 2500000 / 2 500 000 / 2.500.000 / 2,500,000", ["2500000", "2 500 000", "2.500.000", "2,500,000"].every((v) => { const r = parseAmt(v); return "kopeks" in r && r.kopeks === 250000000; }) && parseAmt("").empty && parseAmt("abc").error && amountLib.includes("export function parseImportAmountToKopeks"));

  // ---- Plan preview ----
  const pOk = planPreview({ rawRows: [{ clubIdCell: "c1", clubNameCell: "Клуб 1", monthCell: "2026-07", subsCell: "2 500 000", ptCell: "1 000 000" }], scopeClubs: clubs, currentPlans: [], month: "2026-07" });
  check("PLAN-IMPORT3 общий план = АБ + ПТ (не вводится вручную)", pOk.rows[0].newTotalKopeks === pOk.rows[0].newSubsKopeks + pOk.rows[0].newPtKopeks && pOk.rows[0].newTotalKopeks === 350000000 && planLib.includes("newTotalKopeks: s.kopeks + p.kopeks") && planActions.includes('["total", r.subsKopeks + r.ptKopeks]'));
  const pUpd = planPreview({ rawRows: [{ clubIdCell: "c1", clubNameCell: "Клуб 1", monthCell: "2026-07", subsCell: "100", ptCell: "50" }], scopeClubs: clubs, currentPlans: [{ clubId: "c1", subsKopeks: 999, ptKopeks: 999 }], month: "2026-07" });
  check("PLAN-IMPORT5 при существующем плане строка = update", pUpd.rows[0].status === "update");
  const pNew = planPreview({ rawRows: [{ clubIdCell: "c2", clubNameCell: "Клуб 2", monthCell: "2026-07", subsCell: "100", ptCell: "50" }], scopeClubs: clubs, currentPlans: [], month: "2026-07" });
  check("PLAN preview new → create", pNew.rows[0].status === "create");
  const pScope = planPreview({ rawRows: [{ clubIdCell: "OUTSIDER", clubNameCell: "Чужой", monthCell: "2026-07", subsCell: "100", ptCell: "50" }], scopeClubs: clubs, currentPlans: [], month: "2026-07" });
  check("PLAN-IMPORT8 clubId вне scope → ошибка строки (нельзя импортировать чужой клуб)", pScope.anyError === true && pScope.rows[0].status === "error" && planActions.includes("allowed.has(r.clubId)") && planActions.includes("validClubIds.has(r.clubId)"));
  check("PLAN-IMPORT1/2 owner/GD скачивают шаблон; колонки clubId/Клуб/Город/Месяц/План АБ/План ПТ", planRoute.includes("canImportPlansAndBudgets") && planRoute.includes("buildPlanTemplateBuffer") && planLib.includes('PLAN_TEMPLATE_HEADER = ["clubId", "Клуб", "Город", "Месяц", "План АБ", "План ПТ"]') && planLib.includes('headers: ["clubId"') && planLib.includes('headers: ["План АБ"') && planLib.includes('headers: ["План ПТ"'));
  check("PLAN-IMPORT4 загрузка показывает preview и не применяет до подтверждения (отдельные preview/apply формы + кнопка Применить)", planPanel.includes("previewPlanImport") && planPanel.includes("applyPlanImport") && planPanel.includes("Применить импорт") && planPanel.includes('name="payload"') && planActions.includes("export async function previewPlanImport") && planActions.includes("export async function applyPlanImport") && planActions.includes("prisma.$transaction"));
  check("PLAN-IMPORT7 manager/regional/accountant/marketer не могут импортировать планы (owner/GD only, server-check)", /canImportPlansAndBudgets\(roles: readonly Role\[\]\): boolean \{\s*return roles\.includes\("owner"\) \|\| roles\.includes\("general_director"\)/.test(authSrc) && planActions.includes("if (!canImportPlansAndBudgets(ctx.effectiveRoles))") && /previewPlanImport[\s\S]{0,400}canImportPlansAndBudgets/.test(planActions) && /applyPlanImport[\s\S]{0,400}canImportPlansAndBudgets/.test(planActions));
  check("PLAN-FORMAT1 поля планов в UI показывают разделители тысяч", planForm.includes("groupThousands") && planForm.includes("onInput") && rd("src/app/(app)/dashboard/actions.ts").includes("parseImportAmountToKopeks"));

  // ---- Budget preview ----
  const bOk = budgetPreview({ rawRows: [{ clubIdCell: "c1", clubNameCell: "Клуб 1", monthCell: "2026-07", categoryCell: "Реклама", amountCell: "2 500 000" }, { clubIdCell: "c1", clubNameCell: "Клуб 1", monthCell: "2026-07", categoryCell: "Аренда", amountCell: "500000" }], scopeClubs: clubs, categories: cats, currentBudgets: [], month: "2026-07" });
  check("BUDGET-IMPORT4 бюджет клуба = сумма строк по статьям (per-category upsert, без total-поля)", bOk.rows.length === 2 && bOk.rows[0].category === "advertising" && bOk.rows[0].newKopeks === 250000000 && bOk.rows.reduce((s, r) => s + r.newKopeks, 0) === 300000000 && budgetActions.includes("clubId_category_month") && !budgetActions.includes("totalKopeks"));
  const bScope = budgetPreview({ rawRows: [{ clubIdCell: "OUT", clubNameCell: "Чужой", monthCell: "2026-07", categoryCell: "Реклама", amountCell: "100" }], scopeClubs: clubs, categories: cats, currentBudgets: [], month: "2026-07" });
  check("BUDGET-IMPORT7 clubId вне scope → ошибка (нельзя импортировать чужой клуб)", bScope.anyError === true && budgetActions.includes("allowed.has(r.clubId)") && budgetActions.includes("validClubIds.has(r.clubId)"));
  const bBadCat = budgetPreview({ rawRows: [{ clubIdCell: "c1", clubNameCell: "Клуб 1", monthCell: "2026-07", categoryCell: "Выдумка", amountCell: "100" }], scopeClubs: clubs, categories: cats, currentBudgets: [], month: "2026-07" });
  check("BUDGET preview неизвестная статья → ошибка", bBadCat.anyError === true && bBadCat.rows[0].status === "error");
  const bEmptySkip = budgetPreview({ rawRows: [{ clubIdCell: "c1", clubNameCell: "Клуб 1", monthCell: "2026-07", categoryCell: "Реклама", amountCell: "" }], scopeClubs: clubs, categories: cats, currentBudgets: [], month: "2026-07" });
  check("BUDGET preview пустая сумма пропускается", bEmptySkip.rows.length === 0);
  check("BUDGET-IMPORT1/2 owner/GD скачивают шаблон бюджетов по статьям", budgetRoute.includes("canImportPlansAndBudgets") && budgetRoute.includes("buildBudgetTemplateBuffer") && budgetLib.includes('BUDGET_TEMPLATE_HEADER = ["clubId", "Клуб", "Город", "Месяц", "Статья бюджета", "Сумма"]') && budgetLib.includes('headers: ["Статья бюджета"'));
  check("BUDGET-IMPORT3 preview + подтверждение (отдельные формы + кнопка Применить)", budgetPanel.includes("previewBudgetImport") && budgetPanel.includes("applyBudgetImport") && budgetPanel.includes("Применить импорт") && budgetActions.includes("prisma.$transaction") && budgetActions.includes("budget.upsert"));
  check("BUDGET-IMPORT6 manager/regional/accountant/marketer не могут импортировать бюджеты (owner/GD only)", budgetActions.includes("if (!canImportPlansAndBudgets(ctx.effectiveRoles))") && /previewBudgetImport[\s\S]{0,400}canImportPlansAndBudgets/.test(budgetActions) && /applyBudgetImport[\s\S]{0,400}canImportPlansAndBudgets/.test(budgetActions) && budgetActions.includes("categoryKeys.has(r.category)"));

  // ---- Still-disabled guards ----
  check("NAV-SALES-STILL-DISABLED «Продажи» не вернулся в навигацию", !navSrc.includes('page: "sales", href: "/sales"') && !/\{\s*type:\s*"item",\s*page:\s*"sales"\s*\}/.test(navSrc) && !navSrc.includes('label: "Продажи"'));
  const createBody = salesReportActions.slice(salesReportActions.indexOf("export async function createSalesReport"), salesReportActions.indexOf("export async function uploadSalesReportDocuments"));
  check("SALES-STILL-READONLY /sales read-only, createSalesReport отключён", salesPage.includes("Ручной ввод продаж отключён") && !salesPage.includes("<SalesReportForm") && createBody.includes("MANUAL_SALES_DISABLED_MESSAGE") && !createBody.includes("salesReport.create"));
  check("BALANCES-STILL-REDIRECT /balances всё ещё redirect на /collections", balancesPage.includes('redirect("/collections")') && !balancesPage.includes("BalanceForm"));
  check("AUDIT-STILL-PASS audit report не откатился к открытым рискам", auditDoc.includes("**Final verdict: PASS**") && !auditDoc.includes("PASS WITH RISKS") && auditDoc.includes("both CLOSED by owner decision"));
  check("SECURITY-IMPORT1 нет секретов/raw fiscal JSON/ПДн/реквизитов/stack в импорте (libs/actions/routes/panels)", ![amountLib, planLib, budgetLib, planActions, budgetActions, planRoute, budgetRoute, planPanel, budgetPanel].some((s) => /login|password|integrator|sessionToken|Bearer|rawJson|fiscalSign|ФПД|\bfpd\b|cashierName|cashierInn|\bphone\b|\bemail\b|iban|\.stack/i.test(s)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
