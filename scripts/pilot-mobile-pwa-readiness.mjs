// Mobile + PWA readiness (WAVE 1 foundation). Static guards on the real layout/CSS/manifest/
// service worker/shell/install so the systemic foundation stays correct. No DB. Per-page
// table→card rework (WAVE 2–5) is tracked in the roadmap + verified on real devices.
//   npm run pilot:mobile-pwa-readiness
import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const has = (rel) => existsSync(new URL(rel, import.meta.url));

const layout = src("../src/app/layout.tsx");
const globals = src("../src/app/globals.css");
const appLayout = src("../src/app/(app)/layout.tsx");
const shell = src("../src/app/(app)/_components/MobileShell.tsx");
const manifest = src("../src/app/manifest.ts");
const sw = src("../public/sw.js");
const boot = src("../src/components/pwa/PwaBoot.tsx");
const install = src("../src/components/pwa/InstallGuide.tsx");
const offline = src("../src/app/offline/page.tsx");

// --- Layout / viewport / auto-zoom (§3,§4,§5,§7) ---
check("V1 viewport: viewport-fit=cover (safe-area доступна), width/initialScale", layout.includes('viewportFit: "cover"') && layout.includes('width: "device-width"') && layout.includes("initialScale: 1"));
check("V2 НЕ отключён пользовательский zoom (нет userScalable:false / maximumScale)", !/userScalable\s*:\s*false|maximumScale\s*:|user-scalable\s*=\s*no|maximum-scale\s*=/i.test(layout.replace(/\/\/[^\n]*/g, "")));
check("V3 theme-color per-scheme (light/dark)", /prefers-color-scheme: light/.test(layout) && /prefers-color-scheme: dark/.test(layout));
check("V4 apple standalone: capable + statusBarStyle", layout.includes("appleWebApp") && layout.includes("black-translucent"));
check("C1 глобальный overflow-x guard (нет горизонтального скролла страницы)", /html,[\s\S]{0,400}overflow-x:\s*clip/.test(globals) && globals.includes("max-width: 100%"));
check("C2 inputs ≥16px на mobile (нет iOS auto-zoom), desktop не тронут", /@media \(max-width: 767px\)[\s\S]{0,120}font-size:\s*16px/.test(globals));
check("C3 safe-area утилиты (pt/pb/pl/pr-safe + bottom-nav/actions)", globals.includes("env(safe-area-inset-top)") && globals.includes("env(safe-area-inset-bottom)") && globals.includes(".pb-bottom-nav") && globals.includes(".pb-safe-actions"));
check("C4 break-anywhere для длинных токенов (ФН/UUID/email)", globals.includes(".break-anywhere") && globals.includes("overflow-wrap: anywhere"));
check("C5 standalone-only helpers (скрыть install-подсказку в standalone)", globals.includes("display-mode: standalone") && globals.includes("hide-in-standalone"));

// --- Manifest / icons (§9) ---
check("M1 manifest: name/short_name/start_url/scope/display=standalone", manifest.includes('name: "CLUB-OPS"') && manifest.includes('short_name: "Club Ops"') && manifest.includes('start_url: "/"') && manifest.includes('scope: "/"') && manifest.includes('display: "standalone"'));
check("M2 manifest: background/theme color + orientation + shortcuts", manifest.includes("background_color") && manifest.includes("theme_color") && manifest.includes("shortcuts"));
check("M3 icons: 192 + 512 + maskable (purpose any/maskable)", manifest.includes('sizes: "192x192"') && manifest.includes('sizes: "512x512"') && manifest.includes('purpose: "maskable"') && has("../src/app/pwa/icon-192/route.tsx") && has("../src/app/pwa/icon-512/route.tsx") && has("../src/app/pwa/icon-maskable/route.tsx"));
check("M4 maskable icon с safe-zone (контент внутри, фон в край)", src("../src/app/pwa/icon-maskable/route.tsx").includes("safe zone") || src("../src/app/pwa/icon-maskable/route.tsx").includes("fontSize: 230"));

// --- Service worker / cache policy (§12,§13,§27) ---
check("SW1 регистрация PRODUCTION-only (dev работает без SW)", boot.includes('process.env.NODE_ENV !== "production"') && boot.includes('register("/sw.js")'));
check("SW2 cache-first ТОЛЬКО статик (_next/static, иконки, manifest)", sw.includes("/_next/static/") && sw.includes("isCacheableStatic") && sw.includes("/pwa/icon-") && sw.includes("/manifest.webmanifest"));
check("SW3 навигации network-first → честный /offline (не устаревшие финансы)", sw.includes('req.mode === "navigate"') && sw.includes("caches.match(OFFLINE_URL)"));
check("SW4 данные/API/auth — network-only (не кешируются)", sw.includes("network-only") && sw.includes('req.method !== "GET"') && !/caches\.put\([\s\S]{0,40}api/i.test(sw));
check("SW5 versioned cache + очистка старых на activate + skipWaiting по действию", sw.includes("clubops-static-") && sw.includes("caches.delete") && sw.includes('"SKIP_WAITING"'));
check("SW6 контролируемое обновление: баннер + reload только по клику (не в форме)", boot.includes("Доступно обновление") && boot.includes("SKIP_WAITING") && boot.includes("controllerchange"));
check("SW7 offline-страница честная (нет устаревших сумм)", offline.includes("Нет подключения") && offline.includes("не показывает устаревшие"));
// Structural guarantee (not comment-scanning): the ONLY cache writes are the static-asset
// put + the offline precache. Navigations/data never write to the cache.
const swCode = sw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const putCount = (swCode.match(/\.put\(/g) || []).length;
const addAllCount = (swCode.match(/\.addAll\(/g) || []).length;
const navBranch = (swCode.match(/req\.mode === "navigate"[\s\S]*?\}/) || [""])[0];
check("SEC1 SW пишет в кеш ТОЛЬКО статик+offline; навигации/данные не кешируются; нет секретов в manifest", putCount === 1 && addAllCount === 1 && !/\.put\(/.test(navBranch) && !/secret|token|password/i.test(manifest), `put=${putCount} addAll=${addAllCount}`);

// --- Mobile shell (§6) ---
check("SH1 desktop sidebar/header скрыты на mobile (lg:), mobile shell — lg:hidden", appLayout.includes('className="hidden lg:block"') && appLayout.includes("hidden h-16") && appLayout.includes("lg:flex") && shell.includes("lg:hidden"));
check("SH2 mobile: sticky top bar + гамбургер + safe-area", shell.includes("sticky top-0") && shell.includes("pt-safe") && shell.includes('aria-label="Меню"'));
check("SH3 drawer: полная role-filtered навигация + scope + account", shell.includes("items.map") && shell.includes("{header}") && shell.includes("{account}") && appLayout.includes("visibleItems.map"));
check("SH4 нижняя навигация ≤5 (4 primary + Ещё), role-aware (из visibleItems), ≥44px", shell.includes("slice(0, 4)") && shell.includes("Ещё") && shell.includes("min-h-[52px]") && shell.includes("PRIMARY_ORDER"));
check("SH5 контент не под навигацией (pb-bottom-nav) + min-w-0 guard", appLayout.includes("pb-bottom-nav") && appLayout.includes("min-w-0"));
check("SH6 навигация не показывает запрещённые пункты (visibleItems уже role-filtered)", appLayout.includes("canAnyRoleAccessPage") && appLayout.includes("STRATEGIC_HIDDEN_PAGES"));

// --- Install (§10,§26) ---
check("I1 /install: iPhone Safari шаги + Android prompt, без агрессивных popup", install.includes("beforeinstallprompt") && install.includes("На экран") && install.includes("Safari") && has("../src/app/install/page.tsx"));
check("I2 install скрыт в standalone (уже установлено)", install.includes("display-mode: standalone") && install.includes("уже запущен"));

// --- Auth / standalone (§14) ---
check("A1 auth cookie httpOnly (не localStorage) — standalone-дружелюбно", src("../src/lib/session.ts").includes("httpOnly: true") && !/localStorage[\s\S]{0,40}token/i.test(src("../src/lib/session.ts")));

// --- Desktop regression (§28.45) ---
check("D1 desktop layout сохранён (Sidebar + desktop header под lg:)", appLayout.includes("<Sidebar items={visibleItems}") && appLayout.includes("lg:px-8 lg:py-8"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
