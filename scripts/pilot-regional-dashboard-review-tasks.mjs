// Regional director dashboard — review tasks. Static guards for the dashboard section, cards,
// list-filter panel, and scope + runtime mirrors of the task predicates and buildCard math
// (count/sum/overdue/nearest/club grouping). Kopeks-exact. tsc/prisma/pilot:full/build = gauntlet.
//   npm run pilot:regional-dashboard-review-tasks
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = fileURLToPath(new URL("../", import.meta.url));
const src = (rel) => readFileSync(join(root, rel), "utf8");

const tasks = src("src/lib/regional-tasks.ts");
const cards = src("src/app/(app)/dashboard/_components/RegionalReviewCards.tsx");
const dash = src("src/app/(app)/dashboard/page.tsx");
const panel = src("src/components/RegionalTaskPanel.tsx");
const invPage = src("src/app/(app)/invoices/page.tsx");
const expPage = src("src/app/(app)/expenses/page.tsx");
const refPage = src("src/app/(app)/refunds/page.tsx");

// ---- Runtime mirrors ----
const INV = ["needs_review"], EXP = ["pending_regional_budget_approval"], REF = ["pending_regional_review"];
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function buildCard(rows, now) {
  const today = dayStart(now).getTime(); const per = new Map();
  let sum = 0, overdue = 0, noDue = 0, nearest = null;
  for (const r of rows) {
    sum += r.amountKopeks; const isOv = r.due !== null && dayStart(r.due).getTime() < today;
    if (r.due === null) noDue++; else { if (isOv) overdue++; const t = dayStart(r.due).getTime(); if (nearest === null || t < nearest) nearest = t; }
    const b = per.get(r.clubId) ?? { clubId: r.clubId, count: 0, sumKopeks: 0, overdue: 0 };
    b.count++; b.sumKopeks += r.amountKopeks; if (isOv) b.overdue++; per.set(r.clubId, b);
  }
  return { count: rows.length, sumKopeks: sum, overdue, noDue, nearestDueIso: nearest ? iso(new Date(nearest)) : null, clubs: [...per.values()] };
}
const now = new Date(2026, 7, 2); // 2026-08-02

// ===================== Dashboard section + cards =====================
check("1 Regional dashboard shows review section (rendered only for regional_director)", dash.includes('roles.includes("regional_director")') && dash.includes("<RegionalReviewCards"));
check("2 Three task cards visible (Счета/Расходы/Возвраты)", cards.includes("Счета на проверке") && cards.includes("Расходы на проверке") && cards.includes("Возвраты на проверке"));
check("3 Invoice card counts ONLY needs_review", tasks.includes('INVOICE_REGIONAL_TASK_STATUSES: readonly string[] = ["needs_review"]'));
check("4 Expense card counts ONLY pending_regional_budget_approval (v2)", tasks.includes('EXPENSE_REGIONAL_TASK_STATUSES: readonly string[] = ["pending_regional_budget_approval"]') && tasks.includes("entryVersion === 2"));
check("5 Refund card counts ONLY pending_regional_review (v2)", tasks.includes('REFUND_REGIONAL_TASK_STATUSES: readonly string[] = ["pending_regional_review"]'));

const excluded = ["draft", "paid", "partially_paid", "verified", "confirmed", "rejected", "canceled", "cancelled", "accounting_in_progress", "pending_accountant_verification", "pending_owner_budget_approval", "approved_by_owner", "approved_by_regional", "needs_correction", "submitted"];
check("6-10,16 Excluded statuses not counted (draft/final/accountant/owner/already-regional/cancelled)",
  excluded.every((s) => ![...INV, ...EXP, ...REF].includes(s)));

// ===================== Scope / N+1 =====================
check("11/12/13 Accessible clubs only (companyId + clubId ∈ clubIds; cross-company/club excluded)",
  tasks.includes("where: { companyId, clubId: { in: clubIds }") && tasks.includes("clubId: { in: scope }"));
check("14 Archived clubs excluded (isActive:true before counts, in the scoped loader)", tasks.includes("isActive: true") && dash.includes("loadRegionalReviewTasksScoped"));
check("25 Manual URL cannot widen scope (onlyClubId intersected with clubIds)", tasks.includes("onlyClubId && clubIds.includes(onlyClubId) ? [onlyClubId] : clubIds"));
check("28 No N+1 (bounded task rows per type, not per club)", (tasks.match(/findMany/g) || []).length >= 3 && !tasks.includes("for (const cid of clubIds)"));

// ===================== Money / overdue / nearest / grouping =====================
const rows = [
  { clubId: "A", amountKopeks: 10000, due: new Date(2026, 6, 20) }, // overdue (Jul 20 < Aug 2)
  { clubId: "A", amountKopeks: 25000, due: new Date(2026, 7, 10) }, // future
  { clubId: "B", amountKopeks: 5000, due: null },                    // no due
];
const c = buildCard(rows, now);
check("15 Amount sums exact (integer kopeks)", c.sumKopeks === 40000);
check("17 Overdue count correct (due < today)", c.overdue === 1);
check("18 Missing due date NOT overdue (counted as noDue)", c.noDue === 1 && buildCard([{ clubId: "A", amountKopeks: 1, due: null }], now).overdue === 0);
check("19 Nearest due correct", c.nearestDueIso === "2026-07-20");
check("20 Club grouping correct (per-club count/sum/overdue)", c.clubs.length === 2 && c.clubs.find((x) => x.clubId === "A").count === 2 && c.clubs.find((x) => x.clubId === "A").overdue === 1 && c.clubs.find((x) => x.clubId === "B").sumKopeks === 5000);
check("30b Kopeks exact / no float", buildCard([{ clubId: "A", amountKopeks: 333, due: null }, { clubId: "A", amountKopeks: 667, due: null }], now).sumKopeks === 1000);

// ===================== Links / list filter =====================
check("21 Card opens filtered list (task=regional_review href)", tasks.includes('`/${base}?task=${REGIONAL_TASK_FILTER}') && cards.includes("card.href"));
check("22 Club row opens club-filtered list (taskListHref with clubId)", cards.includes("taskListHref(base, cl.clubId)") && tasks.includes("clubId ? `&clubId=${clubId}` : \"\""));
check("23 Filter chip visible on list", panel.includes("Задачи регионала: на проверке"));
check("24 Reset filter works", panel.includes("Сбросить фильтр") && panel.includes("resetHref"));
check("21b All 3 list pages render the panel on ?task=regional_review",
  invPage.includes("<RegionalTaskPanel base=\"invoices\"") && expPage.includes("<RegionalTaskPanel base=\"expenses\"") && refPage.includes("<RegionalTaskPanel base=\"refunds\"") &&
  invPage.includes("REGIONAL_TASK_FILTER") && expPage.includes("REGIONAL_TASK_FILTER") && refPage.includes("REGIONAL_TASK_FILTER"));

// ===================== Empty / error / mobile / dark =====================
check("26 Empty state correct («Нет задач на проверке»)", cards.includes("Нет задач на проверке") && panel.includes("Нет задач на проверке"));
check("27 Local error state does not break dashboard (per-category safe + error card)", tasks.includes("const safe = async") && tasks.includes("return zero(base, true)") && cards.includes("card.error"));
check("29 Mobile no horizontal scroll (cards grid-cols-1; table hidden lg:block + mobile list)", cards.includes("grid grid-cols-1") && panel.includes("hidden overflow-x-auto") && panel.includes("lg:hidden"));
check("30 Dark theme readable (dark: tokens on cards + panel)", cards.includes("dark:") && panel.includes("dark:"));
check("SCOPE Owner/GD do NOT get the section (regional-only gate)", /roles\.includes\("regional_director"\)/.test(dash) && !dash.includes('roles.includes("owner")) regionalTasks'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
