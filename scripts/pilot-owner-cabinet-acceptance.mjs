// Owner cabinet acceptance — 13 iPhone screenshots. Structural/static guards for the
// owner-role fixes: compact scope filter, dashboard month centering, analytics network
// cards, plan/budget forms, expenses status chips, document-viewer scroll architecture,
// mandatory/payroll layout, users mobile cards, invitation scope RBAC, inactive-entity
// contrast, OFD date stacking, and the finance file-upload guard. Runtime pixel/scroll
// checks are the Playwright harness's job (not run here — no network/browser/OTP).
//   npm run pilot:owner-cabinet-acceptance
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = fileURLToPath(new URL("../", import.meta.url));
const src = (rel) => readFileSync(join(root, rel), "utf8");

// ===================== §2 OwnerScopeFilter compact =====================
const scope = src("src/app/(app)/dashboard/_components/StrategicScopeFilter.tsx");
check("1 OwnerScopeFilter compact mobile: 48px/16px controls, labels above, full-width segmented, chips + alias",
  scope.includes("min-h-[48px]") && scope.includes("text-[16px]") && scope.includes("flex min-w-0 flex-col gap-1") &&
  scope.includes("grid grid-cols-2 gap-1 rounded-lg") && scope.includes("export const OwnerScopeFilter"));

// ===================== §3 Dashboard MonthNav centered =====================
const dash = src("src/app/(app)/dashboard/page.tsx");
check("2 Dashboard month centered: shared MonthNav (DashboardMonthSelector) wrapped w-full sm:w-auto",
  src("src/app/(app)/dashboard/_components/DashboardMonthSelector.tsx").includes("MonthNav") &&
  /w-full sm:w-auto">\s*<DashboardMonthSelector/.test(dash));

// ===================== §4 Analytics network mobile cards =====================
const an = src("src/app/(app)/analytics/page.tsx");
check("3 Analytics «По сетям»: mobile cards (lg:hidden MobileDataCard) + desktop table (hidden lg:block), не обрезано",
  an.includes("space-y-3 lg:hidden") && an.includes("<MobileDataCard") && an.includes("hidden overflow-x-auto rounded-2xl") &&
  an.includes('label: "Клубов"') && an.includes('label: "Результат"'));

// ===================== §5 Sales plans =====================
const plan = src("src/app/(app)/dashboard/_components/PlanImportPanel.tsx");
check("4 Sales plan month + «Показать» не накладываются (MonthField + full-width primary)",
  dash.includes("<MonthField label=\"Месяц\" name=\"month\"") && /Показать[\s\S]{0,40}<\/button>/.test(dash) && dash.includes("grid grid-cols-1 gap-3 sm:flex sm:items-end"));
check("5 Sales plan import → MobileFileField + full-width «Скачать шаблон»/«Загрузить планы»",
  plan.includes('<MobileFileField name="file"') && !plan.includes('type="file"') &&
  plan.includes('buttonClass({ variant: "secondary" })') && plan.includes('buttonClass({ variant: "primary" })'));

// ===================== §6 Expenses status chips =====================
const exp = src("src/app/(app)/expenses/page.tsx");
check("6 Expense status chips scrollable + edge fade + fixed size (active не меняет размер)",
  exp.includes("overflow-x-auto") && exp.includes("bg-gradient-to-l from-[var(--background)]") && exp.includes("min-h-[40px] shrink-0"));

// ===================== §7 Document viewer scroll architecture =====================
const viewer = src("src/components/mobile/DocumentViewer.tsx");
check("7 Document viewer: 100dvh overlay, sticky toolbar, scroll body overflow-y-auto + overscroll-contain + touch pan-y",
  viewer.includes("h-[100dvh]") && viewer.includes("overflow-y-auto overscroll-contain") &&
  viewer.includes('WebkitOverflowScrolling: "touch"') && viewer.includes('touchAction: "pan-y"'));
check("8 Viewer: body-scroll lock + restore scroll position on close (last page reachable without zoom)",
  viewer.includes('body.style.position = "fixed"') && viewer.includes("window.scrollTo(0, scrollY)") && viewer.includes("min-h-[100%] w-full"));

// ===================== §8 Mandatory (payments) layout =====================
const pay = src("src/app/(app)/payments/page.tsx");
check("9 Mandatory/Календарь: shared MonthNav + сроки/остатки split + последняя KPI full-width",
  pay.includes("<MonthNav") && pay.includes("function SectionLabel") && pay.includes('className="col-span-2 lg:col-span-1"'));

// ===================== §9 Budgets =====================
const bf = src("src/app/(app)/budgets/_components/BudgetForms.tsx");
const bi = src("src/app/(app)/budgets/_components/BudgetImportPanel.tsx");
check("10 Budget limit form: Статья/Лимит/Сохранить full-width (grid + cta w-full), 16px card",
  bf.includes("grid grid-cols-1 gap-3") && bf.includes('buttonClass({ variant: "primary", size: "cta" })') && bf.includes("w-full") && bf.includes("p-4"));
check("11 Budget «Скачать шаблон» full-width secondary (текст по центру через buttonClass)",
  bi.includes('buttonClass({ variant: "secondary" })') && bi.includes("w-full sm:w-auto"));
check("12 Budget import → MobileFileField", bi.includes("<MobileFileField name=\"file\"") && !bi.includes('type="file"'));
check("12b Budgets segmented control (shared SegmentedControl/segmentClass)",
  src("src/app/(app)/budgets/page.tsx").includes("SegmentedControl") && src("src/app/(app)/budgets/page.tsx").includes("segmentClass"));

// ===================== §10 Payroll =====================
const pr = src("src/app/(app)/payroll/page.tsx");
const nav = src("src/app/(app)/payroll/_components/PayrollNav.tsx");
check("13 Payroll overview: MonthField + full-width «Показать»", pr.includes("<MonthField") && pr.includes("grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:flex"));
check("14 Payroll tabs scroll safely: contained overflow-x-auto + active auto-centre + whitespace-nowrap",
  nav.includes("overflow-x-auto") && nav.includes("scrollerRef") && nav.includes("scrollLeft") && nav.includes("whitespace-nowrap"));

// ===================== §11 Users list =====================
const users = src("src/app/(app)/users/page.tsx");
check("15 Users mobile cards exist (lg:hidden MobileDataCard: email/роль/доступ/компания/статус + actions)",
  users.includes("space-y-3 lg:hidden") && users.includes("<MobileDataCard") && users.includes('label: "Доступ"') && users.includes("<MemberActions"));
check("16 Users desktop table preserved (hidden lg:block)", users.includes("hidden overflow-hidden rounded-lg border") && users.includes("lg:block"));

// ===================== §12 Invitation scope RBAC =====================
const inv = src("src/app/(app)/users/_components/InviteForm.tsx");
check("17 Invitation club field activates for club-scoped role only (clubScopedRoles-driven, required, no dead disabled select)",
  inv.includes("clubScopedRoles.includes(role)") && inv.includes('name="clubId"') && inv.includes("required") &&
  inv.includes("Доступ ко всей компании") && !inv.includes("disabled={!needsClub}"));
check("18 Invitation server scope validation intact (isClubScopedRole gate, RBAC unchanged)",
  src("src/app/(app)/users/actions.ts").includes("if (isClubScopedRole(role))") &&
  src("src/lib/invites.ts").includes('return role === "manager";'));
check("19 Dark-theme club control not white (theme tokens, no disabled bg-slate-50 club select)",
  inv.includes("dark:bg-slate-900") && inv.includes("dark:text-slate-100") && !inv.includes("disabled:bg-slate-50"));

// ===================== §13 Inactive legal entity contrast =====================
const le = src("src/app/(app)/settings/_components/LegalEntities.tsx");
check("20 Inactive legal entity readable: neutral theme surface + «Неактивно» badge + Activate primary",
  le.includes("bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60") && le.includes("Неактивно") &&
  le.includes('buttonClass({ variant: e.isActive ? "secondary" : "primary"'));
check("21 No full-card opacity for inactive entity", !/isActive[\s\S]{0,120}opacity-/.test(le));

// ===================== §14 OFD date fields =====================
const ofd = src("src/app/(app)/settings/integrations/ofd/_components/OfdForms.tsx");
check("22 OFD date fields stack on mobile (grid grid-cols-1 sm:grid-cols-2 + DateField)",
  ofd.includes("grid grid-cols-1 gap-3 sm:grid-cols-2 lg:flex") && ofd.includes('<DateField name="dateFrom"') && ofd.includes('<DateField name="dateTo"'));
check("23 OFD «Дата от»/«Дата до» do not overlap (12px gap stack) + «Синхронизировать» full-width mobile",
  ofd.includes("flex flex-col gap-3 sm:flex-row") && ofd.includes('idle="Синхронизировать сейчас"'));

// ===================== §15 file-upload guard =====================
const rawFile = /<input[^>]*type="file"/;
const offenders = [];
function walk(dir) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith(".tsx")) {
      const s = readFileSync(join(root, rel), "utf8");
      if (s.includes("mobilefilefield-exempt")) continue;
      if (rawFile.test(s)) offenders.push(rel.split("/").slice(-2).join("/"));
    }
  }
}
walk("src/app");
check("24 No raw <input type=file> in owner finance UI (only shared MobileFileField + exempt bespoke uploaders)", offenders.length === 0, offenders.join(", "));

// ===================== §viewport =====================
check("25 No horizontal page overflow guard (html/body overflow-x clip) + scoped scroll containers",
  src("src/app/globals.css").includes("overflow-x: clip") && exp.includes("overflow-x-auto") && an.includes("overflow-x-auto"));

// ===================== light/dark + desktop regression =====================
check("26 Light/dark tokens present on changed owner components (invite/legal/scope/users)",
  inv.includes("dark:") && le.includes("dark:") && scope.includes("dark:") && users.includes("dark:"));
check("27 Desktop regression absent: analytics/users keep lg:block tables; scope keeps sm: inline row",
  an.includes("lg:block") && users.includes("lg:block") && scope.includes("sm:flex sm:flex-wrap sm:items-end"));
check("28 Owner permissions preserved: club-scoped role set unchanged (manager only); invite gate present",
  src("src/lib/invites.ts").includes('export function isClubScopedRole') && src("src/app/(app)/users/actions.ts").includes("getInvitableRoles"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
