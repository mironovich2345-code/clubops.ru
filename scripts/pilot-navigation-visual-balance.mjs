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
check("N3 иконки в drawer — единый SVG icon-set (NavIcon), без emoji NAV_ICONS", shell.includes("NavIcon") && !shell.includes("NAV_ICONS") && !nav.includes("NAV_ICONS"));
check("N4 capability-hidden маршруты не в drawer (рендер только из filtered items)", shell.includes("byPage.get(") && layout.includes("canAnyRoleAccessPage") && layout.includes("visibleItems"));

// --- Bottom nav REMOVED (final polish) → drawer-only mobile nav ---
check("N5 нижняя навигация полностью удалена (нет fixed bottom-0 nav, нет bottomOrder)", !/fixed inset-x-0 bottom-0/.test(shell) && !shell.includes("bottomOrder") && !layout.includes("bottomNavOrder"));
check("N6 drawer — единственный mobile nav hub (гамбургер открывает drawer)", shell.includes('aria-label="Меню"') && shell.includes("setOpen(true)") && shell.includes("NAV_SECTIONS"));
check("N7 удалён dead-code bottom-nav config (нет BOTTOM_NAV_BY_ROLE/bottomNavOrderForRole)", !nav.includes("BOTTOM_NAV_BY_ROLE") && !nav.includes("bottomNavOrderForRole"));

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

// --- Server/client boundary guard (navigation must stay client-safe) ---
const sidebar = src("../src/components/Sidebar.tsx");
// navigation.ts is imported by client components → must NOT pull server-only runtime in.
check("B1 navigation.ts client-safe: НЕ импортирует runtime auth/session/prisma/next-headers", !/import\s*\{[^}]*\}\s*from\s*"@\/lib\/auth"/.test(nav) && /import type \{[^}]*\} from "@\/lib\/auth"/.test(nav) && !nav.includes('from "@/lib/session"') && !nav.includes('from "next/headers"') && !nav.includes('from "@/lib/prisma"') && !nav.includes('from "@/lib/navigation-server"'));
check("B2 client nav-компоненты (Sidebar/MobileShell) без session/next-headers/prisma/auth-runtime", [sidebar, shell].every((c) => !c.includes('from "@/lib/session"') && !c.includes('from "next/headers"') && !c.includes('from "@/lib/prisma"') && !/import\s*\{[^}]*\}\s*from\s*"@\/lib\/auth"/.test(c)));
check("B3 layout не импортирует удалённый navigation-server", !layout.includes('from "@/lib/navigation-server"'));
check("B4 server-only guard в session/account-container/auth", src("../src/lib/session.ts").includes('import "server-only"') && src("../src/lib/account-container.ts").includes('import "server-only"') && src("../src/lib/auth.ts").includes('import "server-only"'));
check("B5 navigation.ts остаётся client-safe (нет highestRole/runtime auth после удаления bottom-nav)", !nav.includes("highestRole") && !nav.includes("BOTTOM_NAV_BY_ROLE"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
