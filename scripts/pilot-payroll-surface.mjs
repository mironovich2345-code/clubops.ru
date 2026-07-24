// Payroll Stage 7 tests — owner ФОТ aggregates, workflow notifications, and the
// activity-log surfacing of payroll audit events. Mirrors the summary roll-up math
// and statically verifies the notification wiring + activity labels + audit filter.
// npm run pilot:payroll-surface
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = (rub) => rub * 100;

// ---- mirror: summary roll-up (summary/page.tsx) ----
function rollup(byClub) {
  return byClub.reduce(
    (t, r) => ({ accrued: t.accrued + r.accrued, paid: t.paid + r.paid, remaining: t.remaining + r.remaining }),
    { accrued: 0, paid: 0, remaining: 0 },
  );
}

function main() {
  const byClub = [
    { accrued: R(200000), paid: R(150000), remaining: R(50000) },
    { accrued: R(120000), paid: R(120000), remaining: 0 },
  ];
  const t = rollup(byClub);
  check("SURF1 company-wide accrued", t.accrued === R(320000));
  check("SURF2 company-wide paid", t.paid === R(270000));
  check("SURF3 company-wide remaining", t.remaining === R(50000));

  // ---- static guards ----
  const periodActions = src("../src/app/(app)/payroll/periods/actions.ts");
  const activity = src("../src/lib/activity.ts");
  const telegram = src("../src/lib/notifications/telegram.ts");
  const events = src("../src/lib/notifications/events.ts");
  const summary = src("../src/app/(app)/payroll/summary/page.tsx");

  check("SURF4 submit notifies the regional director",
    periodActions.includes('action === "submit"') && periodActions.includes("notifyRegionalReview"));
  check("SURF5 return/approve notify the period author",
    periodActions.includes("notifyAuthor") && periodActions.includes('event: "returned"') && periodActions.includes('event: "approved"'));
  check("SURF6 notifications are best-effort (never block the transition)",
    periodActions.includes("notifications are best-effort"));
  check("SURF7 payroll resource type + titles + deep link wired into the notifier",
    telegram.includes('"payroll.submitted_review"') && telegram.includes('resourceType === "payroll"') && telegram.includes("/payroll/periods/"));
  check("SURF8 events layer accepts the payroll resource type",
    events.includes('"expense" | "invoice" | "refund" | "payroll"'));
  check("SURF9 activity log labels the payroll audit codes",
    activity.includes('"payroll.period_approved": "Период утверждён"') && activity.includes('"payroll.payment_recorded"') && activity.includes('"payroll.obligation_written_off"'));
  check("SURF10 activity log has a Зарплата object label + filter category",
    activity.includes('payroll: "Зарплата"') && activity.includes('key: "payroll", label: "Зарплата", prefixes: ["payroll"]'));
  check("SURF11 summary aggregates by club (grossAccrued/paid/remaining) + debts by direction",
    summary.includes('by: ["clubId"]') && summary.includes('by: ["direction"]') && summary.includes("employee_owes_company") && summary.includes("company_owes_employee"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
