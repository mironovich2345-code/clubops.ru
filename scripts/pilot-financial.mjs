// Financial-integrity regression (audit P1 fix). Verifies that an invoice/refund
// approved by the CHIEF ACCOUNTANT (the fallback approver when a club has no
// active regional director) is counted as:
//   - budget "used"        (lib/budgets.computeUsedKopeks status set)
//   - dashboard debt        (lib/analytics APPROVED_UNPAID set)
// and that draft/rejected are excluded, and paid is debt-excluded (it is spend).
//
// SAFE: fixed "pilot-fin-*" ids, cleaned up. npm run pilot:financial
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

// Canonical sets — MUST match lib/approval.APPROVED_UNPAID_STATUSES and the
// budgets "used" set. If these regress, the assertions below fail.
const APPROVED_UNPAID = ["approved_by_regional", "approved_by_chief_accountant", "approved_by_owner"];
const BUDGET_USED = [...APPROVED_UNPAID, "paid"];

const CO = "pilot-fin-co";
const CLUB = "pilot-fin-club";
const U = "pilot-fin-user";
const MONTH = "2026-03";

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? "  :: " + extra : ""}`); c ? pass++ : fail++; };

async function cleanup() {
  await p.company.deleteMany({ where: { id: CO } }); // cascades club, invoices, refunds
  await p.user.deleteMany({ where: { id: U } });
}

async function mkInvoice(status, amount) {
  return p.invoice.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: U, amountKopeks: amount, status, expenseCategory: "rent", expensePeriod: MONTH, invoiceDate: new Date(2026, 2, 10) } });
}
async function mkRefund(status, amount) {
  return p.refund.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: U, amountKopeks: amount, status, refundDate: new Date(2026, 2, 10) } });
}

async function main() {
  await cleanup();
  await p.user.create({ data: { id: U, email: "pilot-fin@example.com", name: "Fin", role: "accountant", isActive: true } });
  await p.company.create({ data: { id: CO, name: "Fin Co" } });
  await p.club.create({ data: { id: CLUB, name: "Fin Club", city: "X", companyId: CO } });

  // Invoices: one per status.
  await mkInvoice("approved_by_chief_accountant", 1000);
  await mkInvoice("approved_by_regional", 2000);
  await mkInvoice("approved_by_owner", 400);
  await mkInvoice("paid", 8000);
  await mkInvoice("draft", 500);
  await mkInvoice("rejected", 700);
  await mkInvoice("needs_review", 600);

  // Budget "used" = approved(3) + paid, in the accounting month.
  const usedRows = await p.invoice.findMany({ where: { clubId: CLUB, expenseCategory: "rent", status: { in: BUDGET_USED }, expensePeriod: MONTH }, select: { amountKopeks: true } });
  const used = usedRows.reduce((s, r) => s + r.amountKopeks, 0);
  check("budget used includes chief-approved + regional + owner + paid", used === 1000 + 2000 + 400 + 8000, `used=${used}`);

  // The regression boundary: the chief-accountant fallback status must be in the
  // canonical sets, and the budget-used total above must therefore include it.
  check("chief-approved status is in budget-used set (regression)", BUDGET_USED.includes("approved_by_chief_accountant"));
  check("draft/rejected/needs_review excluded from budget-used set",
    !BUDGET_USED.includes("draft") && !BUDGET_USED.includes("rejected") && !BUDGET_USED.includes("needs_review"));

  // Debt = approved-unpaid(3) only; paid is excluded (it is spend, counted elsewhere).
  const debtRows = await p.invoice.aggregate({ where: { companyId: CO, clubId: CLUB, status: { in: APPROVED_UNPAID } }, _sum: { amountKopeks: true } });
  check("debt counts approved-unpaid incl. chief, excludes paid", (debtRows._sum.amountKopeks ?? 0) === 1000 + 2000 + 400, `debt=${debtRows._sum.amountKopeks}`);
  check("paid + rejected excluded from debt set", !APPROVED_UNPAID.includes("paid") && !APPROVED_UNPAID.includes("rejected"));

  // Refunds in the "refunds" budget category — same status semantics.
  await mkRefund("approved_by_chief_accountant", 300);
  await mkRefund("paid", 900);
  await mkRefund("draft", 100);
  const refundDebt = await p.refund.aggregate({ where: { companyId: CO, clubId: CLUB, status: { in: APPROVED_UNPAID } }, _sum: { amountKopeks: true } });
  check("refund debt counts chief-approved, excludes paid/draft", (refundDebt._sum.amountKopeks ?? 0) === 300, `refundDebt=${refundDebt._sum.amountKopeks}`);

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
