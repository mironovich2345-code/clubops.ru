// Mobile visual density pass — Part 1 (Analytics / OFD / Collections / Budgets / History).
// Static guards on the shared density system, bottom-nav scroll-hide, and per-page balance.
//   npm run pilot:mobile-visual-density-part1
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ===================== Density system (§2/§17) =====================
const dens = src("../src/components/mobile/density.tsx");
check("D1 density: CompactPageHeader + CompactMetricCard + DataSummaryCard + MobileDataCard", ["CompactPageHeader", "CompactMetricCard", "DataSummaryCard", "MobileDataCard"].every((c) => dens.includes(`export function ${c}`)));
check("D2 density: SectionHeader + InfoNote + EmptyState + ActiveFilterChips (без дублей 2px)", ["SectionHeader", "InfoNote", "EmptyState", "ActiveFilterChips"].every((c) => dens.includes(`export function ${c}`)));
check("D3 metric value не переносит ₽, clamp font (не мелкий), tabular-nums", dens.includes("whitespace-nowrap") && dens.includes("clamp(1.05rem, 5.5vw, 1.5rem)") && dens.includes("tabular-nums"));
check("D4 breakdown cards заменяют таблицы (title + rows + details), width-safe", dens.includes("break-anywhere") && dens.includes("details") && dens.includes("Подробнее"));

// ===================== Bottom-nav scroll-hide (§5/§16) =====================
const chrome = src("../src/components/mobile/mobile-chrome.ts");
const shell = src("../src/app/(app)/_components/MobileShell.tsx");
check("BN1 hook: hide-on-scroll-down с hysteresis + не на клавиатуре + show at top", chrome.includes("useHideOnScrollDown") && chrome.includes("threshold") && /INPUT\|TEXTAREA\|SELECT/.test(chrome) && chrome.includes("y <= 4"));
check("BN2 suppression store: sticky + overlay (единый, без per-page логики)", chrome.includes("pushStickyActions") && chrome.includes("pushOverlay") && chrome.includes("useChromeSuppressed") && chrome.includes("useSyncExternalStore"));
check("BN3 bottom nav: transform-hide (без layout shift), скрыт при scroll/overlay/drawer", shell.includes("useHideOnScrollDown") && shell.includes("useChromeSuppressed") && shell.includes("translate-y-full") && shell.includes("transition-transform") && shell.includes("open || suppressed || scrollHidden"));
check("BN4 StickyActions скрывает bottom nav (§16)", src("../src/components/mobile/StickyActions.tsx").includes("pushStickyActions"));
check("BN5 Sheet (drawer/sheet) скрывает bottom nav", src("../src/components/mobile/Sheet.tsx").includes("pushOverlay"));

// ===================== OFD sales (§8/§9/§10) =====================
const ofd = src("../src/app/(app)/analytics/ofd-sales/page.tsx");
check("OF1 OFD: compact header + summary cards (DataSummaryCard, без p-5 text-2xl)", ofd.includes("CompactPageHeader") && ofd.includes("DataSummaryCard") && !ofd.includes("rounded-2xl border p-5"));
check("OF2 OFD «По клубам»/«По юрлицам» → desktop table hidden lg:block + mobile cards", ofd.includes("hidden overflow-x-auto rounded-lg border border-slate-200 lg:block") && ofd.includes("space-y-3 lg:hidden") && ofd.includes("<MobileDataCard"));
check("OF3 OFD: компактный month switcher + без Block mb-8", ofd.includes('aria-label="Предыдущий месяц"') && !ofd.includes("mb-8"));

// ===================== Budgets (§14/§15/§16) =====================
const bud = src("../src/app/(app)/budgets/page.tsx");
check("BG1 budgets: compact header + compact filter + segmented control (Бюджеты/План-факт)", bud.includes("CompactPageHeader") && bud.includes("inline-flex rounded-lg bg-slate-100 p-1") && bud.includes("bg-white text-slate-900 shadow-sm"));
check("BG2 budgets лимиты → desktop table hidden lg:block + mobile cards + статус перерасхода", bud.includes("hidden overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm lg:block") && bud.includes("space-y-3 lg:hidden") && bud.includes("budgetStatus(") && bud.includes("budgetRank(") && bud.includes('label: "Перерасход"'));
check("BG3 budgets permission note компактный (InfoNote, не большая карточка)", bud.includes("<InfoNote>Управлять бюджетами"));

// ===================== Action history (§17/§18/§19) =====================
const act = src("../src/app/(app)/activity/page.tsx");
check("AH1 history: mobile FilterSheet (chips + count) + desktop form hidden lg:grid", act.includes("<FilterSheet") && act.includes('formId="activity-filters-mobile"') && act.includes("chips={chips}") && act.includes("mb-5 hidden") && act.includes("lg:grid lg:grid-cols-6"));
check("AH2 history лог → desktop table hidden lg:block + mobile dense cards (details collapsed)", act.includes("hidden overflow-x-auto lg:block") && act.includes("space-y-3 p-3 lg:hidden") && act.includes("<MobileDataCard") && act.includes("details={"));
check("AH3 history: серверная пагинация сохранена (не новая архитектура)", act.includes("result.totalPages") && act.includes("pageHref("));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
