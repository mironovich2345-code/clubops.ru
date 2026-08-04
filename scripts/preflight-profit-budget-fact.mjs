// REM-05 — READ-ONLY profit/budget-fact preflight (§22). SELECT-only; NO writes.
// Surfaces rows that the OLD readers mis-handled and that the canonical services now
// treat correctly, plus data-quality risks (ledgerless paid, missing period/category,
// salary-Expense double-count candidates, cross-tenant, negative amounts).
//   node --env-file=.env scripts/preflight-profit-budget-fact.mjs [--json]
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
const results = [];
const rec = (id, title, sev, count, amountKopeks = null, sample = []) => results.push({ id, title, severity: sev, count, amountKopeks, sample: sample.slice(0, 8) });
const safe = async (id, title, sev, fn) => { try { await fn(id, title, sev); } catch (e) { results.push({ id, title, severity: sev, error: String(e.message || e).slice(0, 160), count: null }); } };

async function main() {
  // 1. partially_paid invoices — dropped by the OLD paid-only fact reader; now recognized in full.
  await safe("PB-01", "partially_paid invoices (were invisible to Plan/Fact; now recognized in full)", "S2", async (id, t, s) => {
    const rows = await prisma.invoice.findMany({ where: { status: "partially_paid" }, select: { id: true, amountKopeks: true } });
    rec(id, t, s, rows.length, rows.reduce((a, r) => a + r.amountKopeks, 0), rows.map((r) => r.id));
  });
  // 2. v2 verified expenses — dropped by OLD confirmed-only Plan/Fact + overruns.
  await safe("PB-02", "v2 verified expenses (were dropped by Plan/Fact + overruns)", "S2", async (id, t, s) => {
    const rows = await prisma.expense.findMany({ where: { status: "verified" }, select: { id: true, amountKopeks: true } });
    rec(id, t, s, rows.length, rows.reduce((a, r) => a + r.amountKopeks, 0), rows.map((r) => r.id));
  });
  // 3. Approved payroll accrual now recognized (was in NO profit/budget reader).
  await safe("PB-03", "approved payroll calcs now recognized as expense (was absent)", "S1", async (id, t, s) => {
    const periods = await prisma.payrollPeriod.findMany({ where: { status: { in: ["regional_approved", "approved", "partially_paid", "paid", "closed"] } }, select: { id: true } });
    if (!periods.length) return rec(id, t, s, 0, 0);
    const calcs = await prisma.payrollCalculation.findMany({ where: { payrollPeriodId: { in: periods.map((p) => p.id) } }, select: { id: true, netPayableKopeks: true } });
    rec(id, t, s, calcs.length, calcs.reduce((a, c) => a + c.netPayableKopeks, 0), calcs.map((c) => c.id));
  });
  // 4/20. Salary-category Expense rows — double-count candidate vs payroll accrual.
  await safe("PB-04", "salary-category Expense rows (double-count candidate vs payroll accrual)", "S1", async (id, t, s) => {
    const rows = await prisma.expense.findMany({ where: { category: { in: ["salary", "payroll", "wages"] }, status: { in: ["confirmed", "verified"] } }, select: { id: true, amountKopeks: true } });
    rec(id, t, s, rows.length, rows.reduce((a, r) => a + r.amountKopeks, 0), rows.map((r) => r.id));
  });
  // 5. Recognized refunds (v1 paid / v2 accounting_in_progress+paid) — separate expense, once.
  await safe("PB-05", "recognized refunds (separate expense, single effect)", "S3", async (id, t, s) => {
    const rows = await prisma.refund.findMany({ where: { OR: [{ entryVersion: 1, status: { in: ["approved_by_regional", "approved_by_chief_accountant", "approved_by_owner", "paid"] } }, { entryVersion: 2, status: { in: ["accounting_in_progress", "paid"] } }] }, select: { id: true, amountKopeks: true, refundResultAmountKopeks: true } });
    rec(id, t, s, rows.length, rows.reduce((a, r) => a + (r.refundResultAmountKopeks ?? r.amountKopeks), 0), rows.map((r) => r.id));
  });
  // 6. Ledgerless paid invoice (FIN-006/DATA-005): recognized but no InvoicePayment rows.
  await safe("PB-06", "ledgerless paid/partially_paid invoice (no InvoicePayment rows)", "S2", async (id, t, s) => {
    const paid = await prisma.invoice.findMany({ where: { status: { in: ["paid", "partially_paid"] } }, select: { id: true, amountKopeks: true } });
    let n = 0, amt = 0; const sample = [];
    for (const i of paid) {
      const c = await prisma.invoicePayment.count({ where: { invoiceId: i.id, status: "confirmed" } });
      if (c === 0) { n++; amt += i.amountKopeks; if (sample.length < 8) sample.push(i.id); }
    }
    rec(id, t, s, n, amt, sample);
  });
  // 7. Recognized invoice missing expensePeriod (silent createdAt fallback risk).
  await safe("PB-07", "recognized invoice with no expensePeriod (fallback used)", "S2", async (id, t, s) => {
    const rows = await prisma.invoice.findMany({ where: { status: { in: ["approved_by_regional", "approved_by_chief_accountant", "approved_by_owner", "partially_paid", "paid"] }, expensePeriod: null }, select: { id: true } });
    rec(id, t, s, rows.length, null, rows.map((r) => r.id));
  });
  // 8. Recognized expense/invoice missing category (→ unassigned bucket, still in total).
  await safe("PB-08", "recognized invoice with no expenseCategory (unassigned bucket)", "S3", async (id, t, s) => {
    const rows = await prisma.invoice.findMany({ where: { status: { in: ["approved_by_regional", "approved_by_chief_accountant", "approved_by_owner", "partially_paid", "paid"] }, expenseCategory: null }, select: { id: true } });
    rec(id, t, s, rows.length, null, rows.map((r) => r.id));
  });
  // 16. Cross-tenant: expense whose club belongs to another company.
  await safe("PB-16", "cross-tenant expense (club.company != expense.company)", "S0", async (id, t, s) => {
    const exps = await prisma.expense.findMany({ select: { id: true, companyId: true, clubId: true } });
    const clubs = new Map((await prisma.club.findMany({ select: { id: true, companyId: true } })).map((c) => [c.id, c.companyId]));
    let n = 0; const sample = [];
    for (const e of exps) if (clubs.get(e.clubId) && clubs.get(e.clubId) !== e.companyId) { n++; if (sample.length < 8) sample.push(e.id); }
    rec(id, t, s, n, null, sample);
  });
  // 19. Negative recognized amount (impossible profit component).
  await safe("PB-19", "negative recognized expense amount", "S1", async (id, t, s) => {
    const rows = await prisma.expense.findMany({ where: { amountKopeks: { lt: 0 }, status: { in: ["confirmed", "verified"] } }, select: { id: true } });
    rec(id, t, s, rows.length, null, rows.map((r) => r.id));
  });

  const summary = { note: "read-only profit/budget-fact preflight (SELECT only)", checks: results };
  try { mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true }); writeFileSync(join(ROOT, "docs/audits/data/profit-budget-preflight.json"), JSON.stringify(summary, null, 2)); } catch { /* best effort */ }
  if (JSON_ONLY) console.log(JSON.stringify(summary, null, 2));
  else { console.log("Profit/budget-fact preflight (read-only)"); for (const c of results) console.log(`  ${c.severity} ${c.id} ${c.title}: ${c.count}${c.amountKopeks != null ? ` (${(c.amountKopeks / 100).toLocaleString("ru")} ₽)` : ""}${c.error ? " ERR:" + c.error : ""}`); }
  const blocking = results.filter((c) => (c.severity === "S0") && c.count > 0);
  await prisma.$disconnect();
  process.exit(blocking.length ? 2 : 0);
}
main().catch(async (e) => { console.error("preflight failed:", String(e.message || e).slice(0, 200)); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
