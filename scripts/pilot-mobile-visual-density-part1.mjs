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

// ===================== Analytics (§6/§7) =====================
const an = src("../src/app/(app)/analytics/page.tsx");
check("AN1 analytics: compact header (CompactPageHeader, без PageHeader)", an.includes("CompactPageHeader") && !an.includes("<PageHeader"));
check("AN2 analytics KPI карточки компактные (p-3, clamp value, без p-5 text-3xl truncate)", an.includes("flex h-full flex-col p-3") && an.includes("clamp(1.1rem, 5.5vw, 1.75rem)") && !an.includes("truncate text-3xl"));
check("AN3 analytics KPI grid 320-safe (не grid-cols-2 базово)", !/grid grid-cols-2 gap-4 lg:grid-cols-4/.test(an) && an.includes("grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-4"));

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

// ===================== Collections (§11/§12) =====================
const acc = src("../src/app/(app)/collections/_components/SingleAccordion.tsx");
const col = src("../src/app/(app)/collections/page.tsx");
check("CL1 single-active accordion (открытие закрывает прочие)", acc.includes("AccordionGroup") && acc.includes("AccordionItem") && acc.includes("openId") && acc.includes("setOpenId(open ? null : id)"));
check("CL2 collections использует single accordion (не независимые <details>)", col.includes("<AccordionGroup>") && (col.match(/<AccordionItem /g) || []).length >= 6 && !col.includes("<details"));
check("CL3 collections: compact header + compact cards (p-4 text-xl, без rounded-2xl p-5)", col.includes("CompactPageHeader") && !col.includes("rounded-2xl border") && !col.includes("p-5 shadow-sm"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
