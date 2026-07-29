// Final iPhone acceptance — DEFERRED residuals: refund FileRow + compact back-link,
// payments (mandatory) MonthNav + full-width action stack + last-KPI full-width,
// employee profile accordion sections + full-width primary actions, payroll tabs
// horizontal-scroll with active-centering, and the finance file-upload sweep to the
// shared MobileFileField behind a static "no raw file input" guard.
// Structural/static checks only — runtime pixel checks are the Playwright harness's
// job (tests/visual), not run here (no network/browser/OTP).
//   npm run pilot:final-iphone-deferred-residuals
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = fileURLToPath(new URL("../", import.meta.url));
const src = (rel) => readFileSync(join(root, rel), "utf8");

// ===================== §1 Refund detail — FileRow + compact back-link + badge =====
const fr = src("src/components/mobile/FileRow.tsx");
check("FR1 FileRow: label отдельно, filename отдельно (truncate+title), compact «Открыть», равная высота строк",
  fr.includes("export function FileRow") &&
  fr.includes('text-xs font-medium text-slate-500') && // label line
  fr.includes("truncate text-sm") && fr.includes("title={filename") && // filename truncates
  fr.includes("min-h-[56px]") && // equal row height
  fr.includes("DocumentLink") && fr.includes("Открыть"));

const rd = src("src/app/(app)/refunds/[id]/page.tsx");
check("FR2 refund detail: FileRow для документов + compact BackLink (не тяжёлая bordered-кнопка) + StatusBadge статуса",
  rd.includes("<FileRow") && rd.includes("function BackLink") && rd.includes("← ") === false && // arrow rendered via aria-hidden span, not raw
  rd.includes("<BackLink") && rd.includes("<StatusBadge") && rd.includes("refundStatusTone") &&
  !/<Link href=\{back\.href\} className="rounded-md border/.test(rd)); // old heavy button gone

// ===================== §2 Mandatory/Календарь платежей — MonthNav + actions + KPI ==
const pm = src("src/app/(app)/payments/page.tsx");
check("MN1 payments: shared MonthNav вместо кастомного ‹/›-навигатора",
  pm.includes('import { MonthNav }') && pm.includes("<MonthNav") &&
  !pm.includes("min-w-[8.5rem]")); // old custom month box removed
check("MN2 payments actions: «Обязательный платёж» primary + «Обновить остаток» secondary, full-width mobile stack",
  pm.includes('buttonClass({ variant: "primary" })') && pm.includes('buttonClass({ variant: "secondary" })') &&
  pm.includes("flex flex-col gap-3 sm:flex-row") && pm.includes("w-full sm:w-auto") &&
  pm.includes("+ Обязательный платёж") && pm.includes("Обновить остаток"));
check("MN3 payments: сроки vs остатки визуально разделены (SectionLabel) + последняя одиночная KPI full-width",
  pm.includes("function SectionLabel") && pm.includes("Сроки оплаты") && pm.includes("Текущие остатки") &&
  pm.includes('className="col-span-2 lg:col-span-1"'));

// ===================== §3 Employee payment profile — accordion + full-width primaries
const ep = src("src/app/(app)/payroll/employees/[id]/page.tsx");
check("EP1 employee: secondary-секции = accordion (details/summary group-open), профиль остаётся открытой секцией",
  ep.includes("function AccordionSection") && ep.includes("<details") && ep.includes("<summary") &&
  ep.includes("group-open:rotate-180") &&
  ep.includes("<AccordionSection title=\"Закрепления") && ep.includes("Схема оплаты") &&
  ep.includes("<AccordionSection title=\"Авансы") && ep.includes("Долги и обязательства"));
const primaryFull = (rel) =>
  src(rel).includes('buttonClass({ variant: "primary", size: "cta" })') && src(rel).includes("w-full sm:w-auto");
check("EP2 employee primary actions full-width (профиль/закрепление/схема через buttonClass cta w-full sm:w-auto)",
  primaryFull("src/app/(app)/payroll/_components/PayrollProfileForm.tsx") &&
  primaryFull("src/app/(app)/payroll/_components/AssignmentForm.tsx") &&
  primaryFull("src/app/(app)/payroll/_components/PaySchemeForm.tsx"));

// ===================== §4 Payroll tabs — horizontal scroll + active centered ========
const nav = src("src/app/(app)/payroll/_components/PayrollNav.tsx");
check("TB1 payroll tabs: contained overflow-x-auto + labels не сжимаются (whitespace-nowrap min-w-max) + активная центрируется + aria-current",
  nav.includes("overflow-x-auto") && nav.includes("min-w-max") && nav.includes("whitespace-nowrap") &&
  nav.includes("scrollerRef") && nav.includes("scrollLeft") && nav.includes('aria-current={active ? "page"'));
check("NHS1 нет горизонтального скролла страницы: html/body overflow-x clip + tab-scroll внутри контейнера",
  src("src/app/globals.css").includes("overflow-x: clip") && nav.includes('ref={scrollerRef} className="-mx-1 overflow-x-auto"'));

// ===================== §5 File upload sweep + static guard ==========================
// Guard: no raw <input type="file"> anywhere under src/app (the finance UI) except a
// file explicitly marked `mobilefilefield-exempt`. The shared component lives outside
// src/app, so any hit here that isn't exempt is an offender.
const rawFile = /<input[^>]*type="file"/;
const offenders = [];
function walk(dir) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith(".tsx")) {
      const s = readFileSync(join(root, rel), "utf8");
      if (s.includes("mobilefilefield-exempt")) continue; // spreadsheet import / bespoke uploader
      if (rawFile.test(s)) offenders.push(rel.split("/").slice(-2).join("/"));
    }
  }
}
walk("src/app");
check("FU-GUARD нет raw <input type=file> в finance UI (кроме shared MobileFileField и exempt-загрузчиков)", offenders.length === 0, offenders.join(", "));
// The converted forms now use MobileFileField.
const converted = [
  "src/app/(app)/expenses/_components/ExpenseUpload.tsx",
  "src/app/(app)/expenses/_components/PayrollUpload.tsx",
  "src/app/(app)/expenses/[id]/_components/ExpenseAttachments.tsx",
  "src/app/(app)/invoices/_components/InvoiceUpload.tsx",
  "src/app/(app)/invoices/[id]/_components/InvoiceEditForm.tsx",
  "src/app/(app)/refunds/_components/RefundUpload.tsx",
  "src/app/(app)/sales/_components/SalesReportDocUpload.tsx",
  "src/app/(app)/sales/_components/SalesReportDocSlots.tsx",
];
check("FU-CONV expenses/refunds/invoices/sales-uploads переведены на MobileFileField (8 форм)",
  converted.every((rel) => src(rel).includes("MobileFileField")), converted.filter((rel) => !src(rel).includes("MobileFileField")).join(", "));
// Exempt files are honestly marked (not silently skipped).
const exempt = [
  "src/app/(app)/dashboard/_components/PlanImportPanel.tsx",
  "src/app/(app)/budgets/_components/BudgetImportPanel.tsx",
  "src/app/(app)/expenses/simple/SimpleExpenseForm.tsx",
  "src/app/(app)/refunds/_components/RefundDraftEditor.tsx",
];
check("FU-EXEMPT spreadsheet-импорты + bespoke-загрузчики явно помечены mobilefilefield-exempt",
  exempt.every((rel) => src(rel).includes("mobilefilefield-exempt")), exempt.filter((rel) => !src(rel).includes("mobilefilefield-exempt")).join(", "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
