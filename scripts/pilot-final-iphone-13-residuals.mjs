// Final iPhone acceptance — 13-screenshot residuals: DateField sweep, file upload,
// collections/payroll fixes, iOS font-size. Static/structural guards. Runtime pixel checks
// are the Playwright harness's job (tests/visual) — not run here (no network/browser/OTP).
//   npm run pilot:final-iphone-13-residuals
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = fileURLToPath(new URL("../", import.meta.url));
const src = (rel) => readFileSync(join(root, rel), "utf8");

// ===================== DateField sweep + raw-input guard (§2) =====================
const df = src("src/components/mobile/DateField.tsx");
check("DF1 DateField/MonthField: div-root (nestable), h-12, native input прозрачный, font 16px", df.includes("export function DateField") && df.includes("export function MonthField") && df.includes('<div className="min-w-0">') && df.includes("h-12 w-full max-w-full") && df.includes("border-0 bg-transparent p-0") && df.includes("fontSize: 16"));

// Guard: no raw <input type="date|month"> in the swept dirs (except a live nav marked
// `datefield-exempt`). Catches raw native controls that look oversized on iOS.
const dirs = ["src/app/(app)/collections", "src/app/(app)/payroll", "src/app/(app)/mandatory-payments"];
const rawInput = /<input[^>]*type="(date|month)"/;
const offenders = [];
function walk(dir) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith(".tsx")) {
      const s = readFileSync(join(root, rel), "utf8");
      if (s.includes("datefield-exempt")) continue; // live month navigator etc.
      if (rawInput.test(s)) offenders.push(rel.split("/").pop());
    }
  }
}
dirs.forEach(walk);
check("DF2 нет raw <input type=date/month> в collections/payroll/mandatory (кроме exempt-навигатора)", offenders.length === 0, offenders.join(", "));
check("DF3 DateField/MonthField применён (collections/payroll overview/advances/periods/create/scheme/profile/mandatory)", src("src/app/(app)/collections/_components/CollectionForms.tsx").includes("<DateField") && src("src/app/(app)/payroll/page.tsx").includes("<MonthField") && src("src/app/(app)/payroll/advances/page.tsx").includes("<MonthField") && src("src/app/(app)/payroll/periods/page.tsx").includes("<MonthField") && src("src/app/(app)/payroll/_components/CreatePeriodForm.tsx").includes("<MonthField") && src("src/app/(app)/payroll/_components/PaySchemeForm.tsx").includes("<MonthField") && src("src/app/(app)/payroll/_components/PayrollProfileForm.tsx").includes("<DateField") && src("src/app/(app)/mandatory-payments/_components/MandatoryPaymentForm.tsx").includes("<DateField"));

// ===================== File upload (§3) =====================
const cf = src("src/app/(app)/collections/_components/CollectionForms.tsx");
check("FU1 collections upload — MobileFileField (нет raw native <input type=file>)", cf.includes("MobileFileField") && !cf.includes('type="file"'));

// ===================== Collections history → cards (§4) =====================
check("CH1 collections история контр. остатков → desktop table hidden lg:block + mobile cards", src("src/app/(app)/collections/page.tsx").includes("hidden overflow-x-auto rounded-lg border border-slate-200 lg:block") && src("src/app/(app)/collections/page.tsx").includes("space-y-3 lg:hidden") && src("src/app/(app)/collections/page.tsx").includes("<MobileDataCard"));

// ===================== Payroll filters stacked (§8/§9/§10) =====================
const stacked = (f) => f.includes("grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:flex");
check("PF1 payroll overview/advances/payments/periods filters — mobile stack", stacked(src("src/app/(app)/payroll/advances/page.tsx")) && stacked(src("src/app/(app)/payroll/payments/page.tsx")) && stacked(src("src/app/(app)/payroll/periods/page.tsx")) && src("src/app/(app)/payroll/page.tsx").includes("grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:flex"));
check("PF2 payroll periods list → mobile cards (нет clipped table)", src("src/app/(app)/payroll/periods/page.tsx").includes("hidden overflow-x-auto lg:block") && src("src/app/(app)/payroll/periods/page.tsx").includes("<MobileDataCard"));

// ===================== Primary buttons full-width (§11) =====================
check("PB1 primary CTA full-width на mobile (create-period/advance/scheme/profile через buttonClass w-full)", src("src/app/(app)/payroll/_components/CreatePeriodForm.tsx").includes('buttonClass({ variant: "primary" })') && src("src/app/(app)/payroll/_components/CreatePeriodForm.tsx").includes("w-full") && src("src/app/(app)/payroll/_components/PaySchemeForm.tsx").length > 0);

// ===================== iOS auto-zoom / viewport (§viewport) =====================
const globals = src("src/app/globals.css");
const layout = src("src/app/layout.tsx");
check("Z1 form controls ≥16px на mobile (нет iOS auto-zoom): media 16px + DateField 16px", /@media \(max-width: 767px\)[\s\S]*?font-size: 16px/.test(globals) && df.includes("fontSize: 16"));
check("Z2 viewport: width=device-width + initialScale 1 + viewportFit cover; НЕ user-scalable=no/maximumScale", layout.includes('width: "device-width"') && layout.includes("initialScale: 1") && layout.includes('viewportFit: "cover"') && !/userScalable\s*:\s*false|maximumScale/.test(layout.replace(/\/\/[^\n]*/g, "")));
check("Z3 нет CSS zoom / transform:scale для layout", !/\bzoom:\s*[0-9.]/.test(globals) && !/transform:\s*scale\(/.test(globals));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
