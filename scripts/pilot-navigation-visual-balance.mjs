// Navigation redesign + account switcher + visual-balance guards. Static assertions on
// the real components (grouped drawer, icons, role-aware bottom nav, account switcher,
// company/club context separation) + the density work already shipped (WAVE-2 cards).
//   npm run pilot:navigation-visual-balance
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const shell = src("../src/app/(app)/_components/MobileShell.tsx");
const nav = src("../src/lib/navigation.ts");
const layout = src("../src/app/(app)/layout.tsx");
const switcher = src("../src/app/(app)/_components/AccountSwitcher.tsx");

// --- Grouped mobile drawer (§12) ---
check("N1 drawer сгруппирован через NAV_SECTIONS (не плоская копия sidebar)", shell.includes("NAV_SECTIONS") && shell.includes('section.type === "item"') && shell.includes("children.length === 0") && shell.includes("toggleGroup"));
check("N2 группы сворачиваемые + запоминаются (localStorage)", shell.includes("openGroups") && shell.includes("clubops:mnav:open") && shell.includes("localStorage.setItem"));
check("N3 иконки в drawer + bottom nav (NAV_ICONS)", shell.includes("NAV_ICONS") && nav.includes("export const NAV_ICONS"));
check("N4 capability-hidden маршруты не в drawer (рендер только из filtered items)", shell.includes("byPage.get(") && layout.includes("canAnyRoleAccessPage") && layout.includes("visibleItems"));

// --- Role-aware bottom nav (§15/§16) ---
check("N5 bottom nav role-aware (bottomOrder prop, не фиксированный PRIMARY_ORDER)", shell.includes("bottomOrder") && !shell.includes("PRIMARY_ORDER") && layout.includes("bottomNavOrder(ctx.effectiveRoles)"));
check("N6 bottom nav ≤4 primary + «Ещё», иконки, ≥52px", shell.includes("slice(0, 4)") && shell.includes("Ещё") && shell.includes("min-h-[52px]"));
check("N7 порядок различается по ролям (owner ≠ manager ≠ accountant)", nav.includes("owner: [") && nav.includes("manager: [") && nav.includes("accountant: [") && nav.includes("bottomNavOrder"));

// --- Account switcher (§10/§11) + context separation (§13) ---
check("N8 account switcher: текущий + другие + add/remove/logout-all", switcher.includes("switchAccountAction") && switcher.includes("startAddAccountAction") && switcher.includes("removeAccountAction") && switcher.includes("logoutAllAction") && switcher.includes("Требуется вход"));
check("N9 switcher встроен в layout, current-account блок сверху drawer", layout.includes("<AccountSwitcher") && layout.includes("listDeviceAccounts") && /account.*top.*§11|Current-account switcher \(top/.test(shell));
check("N10 company/club context (ScopeSwitcher) отделён от account switcher", layout.includes("<ScopeSwitcher") && shell.includes("{header}") && shell.includes("{account}") && !switcher.includes("ScopeSwitcher"));
check("N11 неоднозначная кнопка «Выйти» заменена явными действиями (§8)", !/action=\{logoutAction\}/.test(layout));

// --- Touch targets + desktop untouched ---
check("N12 touch targets ≥44px в drawer nav", (shell.match(/min-h-\[44px\]/g) || []).length >= 2);
check("N13 desktop sidebar не тронут (Sidebar под lg:block, отдельный header lg:flex)", layout.includes('className="hidden lg:block"') && layout.includes("<Sidebar items={visibleItems}") && layout.includes("lg:flex"));

// --- Density already shipped (WAVE 2 reference) ---
check("N14 invoices/refunds уже карточки (эталон плотности сохранён)", src("../src/app/(app)/invoices/page.tsx").includes("space-y-3 p-3 lg:hidden") && src("../src/app/(app)/refunds/page.tsx").includes("space-y-3 p-3 lg:hidden"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
