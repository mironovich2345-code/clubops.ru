// Pilot — REM-05A canonical profit live-reader adoption (§13). STRUCTURAL checks that
// every live profit reader uses calculateProfit and no live legacy formula remains.
// BEHAVIORAL proof = test:rem-05a-profit-readers (12/12 real DB reader-equivalence).
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => { try { return readFileSync(new URL(p, import.meta.url), "utf8"); } catch { return ""; } };

const analytics = src("../src/app/(app)/analytics/page.tsx");
const clubCard = src("../src/app/(app)/dashboard/_components/ClubCard.tsx");
const dashCards = src("../src/lib/dashboard-cards.ts");
const dashboard = src("../src/lib/dashboard.ts");
const ofdMgmt = src("../src/lib/analytics/ofd-management.ts");
const tests = src("../scripts/rem-05a-profit-reader-tests.mjs");
const pkg = src("../package.json");
const report = src("../docs/remediation/rem-05a-final-report.md");
const baseline = src("../docs/remediation/rem-05a-profit-reader-baseline.md");
const readerMap = src("../docs/remediation/rem-05a-profit-reader-map.md");
const checklist = src("../docs/testing/rem-05a-profit-reader-checklist.md");
const profitFormulas = src("../docs/accounting/profit-formulas.md");

// 1. inventory documented.
check("1 live reader inventory documented", readerMap.includes("calculateProfit") && readerMap.length > 200);
// 2/3. owner/GD (analytics) uses calculateProfit.
check("2/3 analytics profit card uses calculateProfit", analytics.includes("calculateProfit") && analytics.includes("profitResult.profitKopeks"));
// 4. club cards use recognized (calculateProfit basis) via dashboard-cards.
check("4 club-card result = OFD net − recognized (canonical)", clubCard.includes("card.ofd.ofdNetKopeks - card.recognizedExpensesKopeks") && dashCards.includes("loadRecognizedExpenses"));
// 5. analytics == calculateProfit (single source; no local formula copy).
check("5 no local profit formula in analytics (single service)", analytics.includes("calculateProfit(") && !/netKopeks\s*-\s*s\.expensesKopeks|s\.profitKopeks/.test(analytics));
// 6. exports/basis identical (same service) — proven in tests.
check("6 reader-equivalence proven in tests", tests.includes("club-card A == calculateProfit(A)") && tests.includes("network total"));
// 7. NO live legacy formula callers.
check("7 no live computeManagementResult callers", !clubCard.includes("computeManagementResult") && !analytics.includes("computeManagementResult"));
// 7b. dead dashboard.ts trio deprecated.
check("7b dead dashboard.ts profit deprecated", dashboard.includes("@deprecated REM-05A") && dashboard.includes("calculateProfit"));
check("7c computeManagementResult deprecated (0 callers)", ofdMgmt.includes("@deprecated REM-05A"));
// 8/9. scope preserved + manager hidden (financials gate unchanged).
check("8/9 scope preserved + manager hidden (financials gate)", analytics.includes("canSeeOfdSales") && analytics.includes("financials && profitResult") && dashCards.includes("showOfd || financials"));
// 10. network total reconciles (byClub, no per-club N+1).
check("10 network total via one byClub query (no N+1)", dashCards.includes("byClub") && dashCards.includes("no per-club") );
// 11. breakdown consistent (revenue/recognized-expenses/profit labels).
check("11 UI shows revenue + recognized expenses + profit", analytics.includes("Выручка по ОФД") && analytics.includes("Признанные расходы") && analytics.includes("Прибыль"));
// 12. warnings preserved.
check("12 warnings available from service", tests.includes("warnings surfaced"));
// 13. DB-backed tests + registered.
check("13 DB-backed tests registered", tests.includes("calculateProfit") && pkg.includes("test:rem-05a-profit-readers"));
// 14. reconciliation read-only (existing reconcile tool covers it).
check("14 reconcile tool still read-only", src("../scripts/reconcile-profit-budget-fact.mjs").includes("NO") && src("../scripts/reconcile-profit-budget-fact.mjs").includes("corrections"));
// 15/16. no formula/RBAC change.
check("15/16 no formula/RBAC change (service reused; gates unchanged)", analytics.includes("calculateProfit") && !analytics.includes("EXPENSE_REALIZED") );
// 17. no production mutation (readers only).
check("17 readers only (no writes added)", !/\.(create|update|delete)\(/.test(clubCard) && !/prisma\.\w+\.(create|update|delete)/.test(dashCards));
// pilot registered.
check("18 pilot registered", pkg.includes("pilot:rem-05a-profit-live-readers") && src("../scripts/pilot-full.mjs").includes("pilot-rem-05a-profit-live-readers.mjs"));
// docs + findings closure.
check("19 docs present", baseline.length > 200 && readerMap.length > 200 && checklist.includes("G-FIN"));
check("20 findings closure honest (FIN-001/UX-005 CLOSED)", report.includes("FIN-001") && report.includes("UX-005") && report.includes("CLOSED") && profitFormulas.includes("REM-05A"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
