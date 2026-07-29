// Final mobile visual polish — static guards: no emoji, no bottom nav, bounded drawer,
// symmetric header, stacked company/club, form-control bounds, employees cards.
//   npm run pilot:final-mobile-visual-polish
import { readFileSync, readdirSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// True pictographic emoji (not plain arrows/checks used as text).
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u;

// ===================== No emoji in nav config + mobile UI =====================
const mobileDir = new URL("../src/components/mobile/", import.meta.url);
const mobileFiles = readdirSync(mobileDir).filter((f) => /\.(tsx?|ts)$/.test(f)).map((f) => `../src/components/mobile/${f}`);
const scanned = [
  "../src/lib/navigation.ts",
  "../src/app/(app)/_components/MobileShell.tsx",
  "../src/app/(app)/_components/AccountSwitcher.tsx",
  "../src/app/(app)/_components/ScopeSwitcher.tsx",
  "../src/app/manifest.ts",
  "../src/components/BudgetFactTable.tsx",
  ...mobileFiles,
];
const withEmoji = scanned.filter((f) => EMOJI.test(src(f)));
check("E1 нет эмодзи в navigation config + mobile UI (nav.ts, components/mobile/**, shell, switcher, manifest, BudgetFactTable)", withEmoji.length === 0, withEmoji.map((f) => f.split("/").pop()).join(", "));
check("E2 единый SVG icon-set (NavIcon + UI-иконки, currentColor stroke, aria-hidden)", src("../src/components/mobile/icons.tsx").includes("export function NavIcon") && src("../src/components/mobile/icons.tsx").includes('stroke="currentColor"') && src("../src/components/mobile/icons.tsx").includes("aria-hidden") && ["MenuIcon", "CloseIcon", "ChevronDownIcon", "FilterIcon"].every((i) => src("../src/components/mobile/icons.tsx").includes(`export const ${i}`)));

// ===================== Bottom nav removed =====================
const shell = src("../src/app/(app)/_components/MobileShell.tsx");
const layout = src("../src/app/(app)/layout.tsx");
const globals = src("../src/app/globals.css");
check("BN1 нижнее меню удалено (нет fixed bottom-0 nav, нет bottomOrder/scroll-hide)", !/fixed inset-x-0 bottom-0/.test(shell) && !shell.includes("bottomOrder") && !shell.includes("translate-y-full") && !shell.includes("useHideOnScrollDown"));
check("BN2 нет bottom-nav spacer (.pb-bottom-nav удалён; main — safe-area padding)", !/\.pb-bottom-nav\s*\{/.test(globals) && !layout.includes("pb-bottom-nav") && layout.includes("env(safe-area-inset-bottom)"));

// ===================== Drawer + header bounds =====================
check("DR1 drawer bounded (w-[min(88vw,360px)], overflow-x-hidden, min-w-0 children)", shell.includes("w-[min(88vw,360px)]") && shell.includes("overflow-x-hidden") && (shell.match(/min-w-0/g) || []).length >= 3);
check("DR2 symmetric top bar grid 44/1fr/44 + 44px hamburger", shell.includes("grid-cols-[44px_1fr_44px]") && shell.includes("h-11 w-11") && shell.includes('aria-label="Меню"'));
check("DR3 company/club stack на mobile (ScopeSwitcher flex-col, не 2 select в ряд)", src("../src/app/(app)/_components/ScopeSwitcher.tsx").includes("flex flex-col gap-3") && src("../src/app/(app)/_components/ScopeSwitcher.tsx").includes("lg:flex-row") && src("../src/app/(app)/_components/ScopeSwitcher.tsx").includes("block min-w-0"));

// ===================== Form controls =====================
check("FC1 глобально: input/select/textarea max-width:100% + box-sizing; date/month width clamp (§18)", /input,\s*\n\s*select,\s*\n\s*textarea\s*\{[\s\S]*?max-width: 100%;[\s\S]*?box-sizing: border-box;/.test(globals) && /input\[type="date"\][\s\S]*?width: 100%/.test(globals));

// ===================== Employees cards + desktop intact =====================
const emp = src("../src/app/(app)/employees/page.tsx");
check("EMP1 employees: desktop table hidden lg:block + mobile MobileDataCard cards", emp.includes("hidden overflow-x-auto lg:block") && emp.includes("space-y-3 p-3 lg:hidden") && emp.includes("<MobileDataCard"));
check("REG1 desktop не тронут (Sidebar под lg:block, mobile shell lg:hidden)", layout.includes('className="hidden lg:block"') && layout.includes("<Sidebar items={visibleItems}") && shell.includes("lg:hidden"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
