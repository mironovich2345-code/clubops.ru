// UI consistency pass — color system, filters, date fields, buttons, theme-in-drawer.
// Static/structural guards for the screenshot-driven fixes. Runtime pixel checks live in
// the Playwright harness (tests/visual) — not run here (no network/browser/OTP).
//   npm run pilot:ui-consistency-color-filter-pass
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ===================== Color system (§3/§7) =====================
const css = src("../src/app/globals.css");
check("C1 семантические токены добавлены (surface/border/text/accent/info)", ["--surface-page", "--surface-card", "--surface-elevated", "--surface-muted", "--border-subtle", "--border-strong", "--text-primary", "--text-secondary", "--text-muted", "--accent-primary", "--accent-soft", "--info"].every((t) => css.includes(t)));
check("C2 dark нейтрализован (graphite, НЕ navy #0b1220/#0e1626)", css.includes("--background: #101114") && css.includes("--card: #191a1e") && !css.includes("#0b1220") && !css.includes("#0e1626"));
check("C3 segmented active = accent-soft, не яркая синяя плита (нет dark:bg-slate-700 active)", src("../src/components/mobile/buttons.tsx").includes("bg-[var(--accent-soft)]") && !src("../src/components/mobile/buttons.tsx").includes("dark:bg-slate-700"));

// ===================== Theme control in drawer (§2) =====================
const theme = src("../src/components/ThemeToggle.tsx");
check("T1 theme: inline segmented на mobile (lg:hidden), popover только desktop (lg:block) — не выходит за drawer", theme.includes('role="radiogroup"') && theme.includes("lg:hidden") && theme.includes('relative hidden lg:block') && theme.includes("bg-[var(--accent-soft)]"));

// ===================== Company/club selectors (§2) =====================
const scope = src("../src/app/(app)/_components/ScopeSwitcher.tsx");
check("S1 company/club: один neutral surface (нет двойного тёмного bg-slate-100), 48px, label", scope.includes("bg-[var(--surface-card)]") && scope.includes("border border-[var(--border-subtle)]") && !scope.includes("bg-slate-100") && scope.includes("h-12"));

// ===================== DateField (§6) =====================
const df = src("../src/components/mobile/DateField.tsx");
check("D1 shared DateField/MonthField: wrapper владеет border/bg/height 48px, input прозрачный 16px", df.includes("export function DateField") && df.includes("export function MonthField") && df.includes("h-12 w-full max-w-full") && df.includes("border-0 bg-transparent p-0") && df.includes("fontSize: 16"));
check("D2 DateField применён к Analytics/Budgets/Payroll", src("../src/app/(app)/analytics/page.tsx").includes("<DateField") && src("../src/app/(app)/budgets/page.tsx").includes("<MonthField") && src("../src/app/(app)/payroll/periods/page.tsx").includes("<MonthField") && src("../src/app/(app)/payroll/_components/CreatePeriodForm.tsx").includes("<MonthField"));

// ===================== Analytics filter (§5) =====================
const an = src("../src/app/(app)/analytics/page.tsx");
check("A1 analytics фильтр: mobile stack (grid) + DateField + full-width Показать (нет overlap flex-wrap items-end)", an.includes("grid grid-cols-1 gap-3 p-4") && an.includes("lg:flex lg:flex-wrap lg:items-end") && /buttonClass\(\{ variant: "primary" \}\)\} w-full lg:w-auto/.test(an) && !an.includes("flex flex-wrap items-end gap-2 p-2"));

// ===================== Collections sync buttons (§8) =====================
const cf = src("../src/app/(app)/collections/_components/CollectionForms.tsx");
check("CS1 collections sync: 2 равные SECONDARY кнопки (grid 2-col), не 2 ярко-синие primary", cf.includes("grid grid-cols-1 gap-3 min-[420px]:grid-cols-2") && cf.includes('variant="secondary" fluid') && cf.includes('idle="Синхронизировать наличные ИП" busy="Синхронизация..." variant="secondary"'));

// ===================== Budgets filter + segmented (§9) =====================
const bud = src("../src/app/(app)/budgets/page.tsx");
check("BG1 budgets фильтр: full-width stack + MonthField + full-width Показать; segmented shared", bud.includes("grid grid-cols-1 gap-3") && bud.includes("<MonthField label=\"Месяц\"") && /buttonClass\(\{ variant: "primary" \}\)\} w-full lg:w-auto/.test(bud) && bud.includes("<SegmentedControl>"));

// ===================== Payroll (§10/§11) =====================
const per = src("../src/app/(app)/payroll/periods/page.tsx");
check("P1 payroll periods фильтр: mobile stack (grid 1→2) + MonthField + checkbox own row + full-width Показать", per.includes("grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:flex") && per.includes("<MonthField") && per.includes("только проблемные") && /buttonClass\(\{ variant: "primary" \}\)\} w-full min-\[380px\]:col-span-2/.test(per));
check("P2 payroll periods: desktop table hidden lg:block + mobile cards (нет clipped table)", per.includes("hidden overflow-x-auto lg:block") && per.includes("space-y-3 p-3 lg:hidden") && per.includes("<MobileDataCard") && per.includes("periodTone("));
check("P3 payroll create-period: full-width stack + MonthField + full-width CTA", src("../src/app/(app)/payroll/_components/CreatePeriodForm.tsx").includes("grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:flex") && src("../src/app/(app)/payroll/_components/CreatePeriodForm.tsx").includes("buttonClass({ variant: \"primary\" })"));

// ===================== Buttons unified + desktop intact =====================
check("U1 primary кнопки — единый buttonClass (analytics/budgets/payroll/collections)", [an, bud, per, cf].every((f) => f.includes("buttonClass(")));
check("U2 desktop не сломан (фильтры/таблицы под lg:, desktop inline сохранён)", an.includes("lg:flex") && per.includes("lg:block") && scope.includes("lg:flex-row"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
