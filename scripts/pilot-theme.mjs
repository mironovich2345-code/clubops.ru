// Dark-mode toggle — static UI checks (no business logic, no DB). Verifies the
// theme toggle, persistence, anti-flash, and that the light theme stays intact.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? `  ${x}` : ""}`); c ? pass++ : fail++; };
const rd = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const globals = rd("src/app/globals.css");
const rootLayout = rd("src/app/layout.tsx");
const appLayout = rd("src/app/(app)/layout.tsx");
const toggle = rd("src/components/ThemeToggle.tsx");
const tailwind = rd("tailwind.config.ts");
const PAGES = {
  dashboard: rd("src/app/(app)/dashboard/page.tsx"),
  expenses: rd("src/app/(app)/expenses/page.tsx"),
  collections: rd("src/app/(app)/collections/page.tsx"),
  ofdSales: rd("src/app/(app)/analytics/ofd-sales/page.tsx"),
  ofdSettings: rd("src/app/(app)/settings/integrations/ofd/page.tsx"),
};

check("THEME1 default is system (не ломает: system→OS, иначе light); ThemeToggle стартует с 'system'", /localStorage\.getItem\('theme'\)\|\|'system'/.test(rootLayout) && toggle.includes('useState<Theme>("system")') && toggle.includes('(theme === "system" && systemPrefersDark())'));
check("THEME2 выбор dark добавляет класс 'dark' на html (Tailwind darkMode: class)", toggle.includes('classList.toggle("dark", isDark)') && /classList\.toggle\('dark',d\)/.test(rootLayout) && tailwind.includes('darkMode: "class"'));
check("THEME3 выбор сохраняется в localStorage", toggle.includes('localStorage.setItem("theme", next)') && rootLayout.includes("localStorage.getItem('theme')"));
check("THEME4 после reload тема применяется до гидрации (inline script в <head> читает localStorage)", rootLayout.includes("<head>") && rootLayout.includes("dangerouslySetInnerHTML") && rootLayout.includes("THEME_INIT") && rootLayout.includes('suppressHydrationWarning'));
check("THEME5 светлая тема не ломается: все dark-правила скоупятся под .dark; :root остаётся светлым; нет unscoped-переопределений", globals.includes("color-scheme: light") && globals.includes(".dark {") && globals.includes(".dark .bg-white") && !/\n\.bg-white\s*\{/.test(globals) && !/\n\.text-slate-900\s*\{/.test(globals) && !/\n\.bg-slate-50\s*\{/.test(globals));
check("THEME6 ThemeToggle есть в верхней панели app-layout", appLayout.includes('from "@/components/ThemeToggle"') && /<ThemeToggle\s*\/>/.test(appLayout) && toggle.includes("Светлая") && toggle.includes("Тёмная") && toggle.includes("Системная"));

// THEME7 — main pages use the tokenized neutral surfaces that .dark remaps centrally.
const tokenRemaps = globals.includes(".dark .bg-white") && globals.includes(".dark .bg-slate-50") && globals.includes(".dark .text-slate-900") && globals.includes(".dark .border-slate-200");
for (const [name, src] of Object.entries(PAGES)) {
  check(`THEME7 ${name}: использует токенизированные нейтральные классы (bg-white/bg-slate-50), не хардкод-белый; централизованный .dark remap активен`, (src.includes("bg-white") || src.includes("bg-slate-50")) && tokenRemaps && !/#fff\b|#ffffff|bg-\[#f/i.test(src));
}

// THEME8 — no mass new hardcoded white/black backgrounds in themed UI (globals is the
// token file and legitimately holds hex values, so it is excluded).
const themedUi = { ...PAGES, toggle, appLayout, rootLayout };
const offenders = Object.entries(themedUi).filter(([, s]) => /background(-color)?\s*:\s*(#fff|#ffffff|white)\b/i.test(s) || /\bbg-\[#(fff|ffffff)\]/i.test(s));
check("THEME8 нет массового нового hardcoded white/black фона, ломающего dark mode", offenders.length === 0, offenders.map(([k]) => k).join(","));
check("THEME8b тёмная тема не pure black: фон/карта тёмно-серые, borders видимые (токены заданы)", /--background:\s*#0b1220/i.test(globals) && /--card:\s*#111827/i.test(globals) && /--border:\s*#273244/i.test(globals) && globals.includes(".dark input"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
