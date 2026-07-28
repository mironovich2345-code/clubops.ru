// Final mobile visual polish — Part 2 static/structural guards. Verifies the Button
// system, MonthNav, and the per-page layout fixes the screenshots surfaced, plus that
// the real Playwright bounding-box harness exists.
// NOTE: runtime bounding-box/overlap checks are the Playwright spec's job (tests/visual/
// mobile-visual.spec.ts) — they require a running authenticated app + a browser and are
// NOT run here (sandbox has no network/browser). This pilot guards the code + harness.
//   npm run pilot:final-mobile-visual-polish-part2
import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const has = (rel) => existsSync(new URL(rel, import.meta.url));

// ===================== Button system (§1) =====================
const btn = src("../src/components/mobile/buttons.tsx");
check("B1 button system: Primary/Secondary/Danger/Ghost/Icon + ActionButtonRow + SegmentedControl", ["PrimaryButton", "SecondaryButton", "DangerButton", "GhostButton", "IconButton", "ActionButtonRow", "SegmentedControl"].every((c) => btn.includes(`export function ${c}`) || btn.includes(`export const ${c}`)));
check("B2 button rules: ≥44px, CTA 48px, centered, single focus ring, block=full-width", btn.includes("min-h-[48px]") && btn.includes("min-h-[44px]") && btn.includes("items-center justify-center") && btn.includes("focus-visible:ring") && btn.includes('block ? "w-full"'));
check("B3 ActionButtonRow: 1 → full-width; 2 → grid 1fr/1fr → stack на узком; IconButton требует label", btn.includes("min-[380px]:grid-cols-2") && /items\.length <= 1/.test(btn) && btn.includes("label: string"));

// ===================== MonthNav (§3/§4) =====================
const mn = src("../src/components/mobile/MonthNav.tsx");
check("MN1 MonthNav: симметричные 44×44 стрелки + центр label + badge отдельной строкой", mn.includes("h-11 w-11") && mn.includes("flex-1 truncate text-center") && mn.includes("mt-2 flex justify-center") && mn.includes("ChevronLeftIcon") && mn.includes("ChevronRightIcon"));
check("MN2 MonthNav применён к Dashboard + OFD", src("../src/app/(app)/dashboard/_components/DashboardMonthSelector.tsx").includes("<MonthNav") && src("../src/app/(app)/analytics/ofd-sales/page.tsx").includes("<MonthNav"));

// ===================== Expenses (§2) =====================
const exp = src("../src/app/(app)/expenses/page.tsx");
check("E1 expenses top-actions: равная высота, 2 колонки на mobile (стек <380px), desktop inline", exp.includes("grid grid-cols-1 gap-2 min-[380px]:grid-cols-2 lg:flex") && exp.includes('buttonClass({ variant: "secondary" })') && exp.includes('buttonClass({ variant: "primary" })'));
check("E2 expenses status-filters: один ряд horizontal-scroll chips (не хаотичный wrap)", exp.includes("flex gap-2 overflow-x-auto") && exp.includes("shrink-0 items-center whitespace-nowrap rounded-full") && exp.includes("mt-4"));

// ===================== Invoices (§4) =====================
const inv = src("../src/app/(app)/invoices/page.tsx");
check("I1 invoices KPI: 5-я карта full-width (не одинокая половинная); value не truncate", inv.includes('className="min-[400px]:col-span-2 lg:col-span-1"') && inv.includes("whitespace-nowrap text-lg font-semibold tabular-nums"));

// ===================== Collections + Employees CTA (§5) =====================
check("CE1 Collections + Employees primary CTA full-width на mobile (buttonClass cta block)", src("../src/app/(app)/collections/_components/CollectionForms.tsx").includes('buttonClass({ variant: "primary", size: "cta", block: true })') && src("../src/app/(app)/employees/_components/EmployeeForm.tsx").includes('buttonClass({ variant: "primary", size: "cta", block: true })'));

// ===================== Playwright harness exists (§8) =====================
check("PW1 real Playwright harness: config + spec + bounding-box assertions + contact sheet", has("../playwright.config.ts") && has("../tests/visual/mobile-visual.spec.ts") && src("../tests/visual/mobile-visual.spec.ts").includes("no horizontal page overflow") && src("../tests/visual/mobile-visual.spec.ts").includes("controls within viewport") && has("../tests/visual/contact-sheet.mjs") && has("../tests/visual/README.md"));
check("PW2 harness покрывает нужные ширины 320–1440 + light/dark", src("../playwright.config.ts").includes("[320, 568]") && src("../playwright.config.ts").includes("[430, 932]") && src("../playwright.config.ts").includes("[1440, 900]") && src("../tests/visual/mobile-visual.spec.ts").includes('["light", "dark"]'));
check("PW3 tests/visual исключён из tsc (нет ложных ошибок @playwright/test офлайн)", src("../tsconfig.json").includes('"tests/visual"') && src("../tsconfig.json").includes('"playwright.config.ts"'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
