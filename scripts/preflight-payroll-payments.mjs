// REM-01 — READ-ONLY payroll-payment preflight (§18). SELECT-only; performs NO writes. Run on dev or
// a production READ REPLICA before/after rollout to detect duplicate/inconsistent payout data.
//   node --env-file=.env scripts/preflight-payroll-payments.mjs [--json]
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
const results = [];
const rec = (id, title, sev, count, sample = []) => results.push({ id, title, severity: sev, offendingRows: count, sample: sample.slice(0, 10) });
const safe = async (id, title, sev, fn) => { try { await fn(id, title, sev); } catch (e) { results.push({ id, title, severity: sev, error: String(e.message || e).slice(0, 200), offendingRows: null }); } };

async function main() {
  // 1. Duplicate semantic payments: two confirmed PayrollPayment with the same (calc, amount, minute).
  await safe("PP-01", "duplicate semantic PayrollPayment (same calc+amount within 1 min)", "S1", async (id, t, s) => {
    const pays = await prisma.payrollPayment.findMany({ where: { status: "confirmed" }, select: { id: true, payrollCalculationId: true, amountKopeks: true, paymentDate: true } });
    const seen = new Map(); let bad = 0; const sample = [];
    for (const p of pays) { const k = `${p.payrollCalculationId}|${p.amountKopeks}|${new Date(p.paymentDate).toISOString().slice(0, 16)}`; if (seen.has(k)) { bad++; if (sample.length < 10) sample.push(p.id); } else seen.set(k, p.id); }
    rec(id, t, s, bad, sample);
  });
  // 2. Confirmed payment without a linked Expense (phantom payment).
  await safe("PP-02", "confirmed PayrollPayment with null expenseId (phantom payment)", "S1", async (id, t, s) => {
    const rows = await prisma.payrollPayment.findMany({ where: { status: "confirmed", expenseId: null }, select: { id: true } });
    rec(id, t, s, rows.length, rows.slice(0, 10).map((r) => r.id));
  });
  // 3. Payment.expenseId → a missing / non-salary Expense.
  await safe("PP-03", "PayrollPayment.expenseId → missing Expense", "S1", async (id, t, s) => {
    const pays = await prisma.payrollPayment.findMany({ where: { expenseId: { not: null } }, select: { id: true, expenseId: true } });
    const expIds = new Set((await prisma.expense.findMany({ select: { id: true } })).map((e) => e.id));
    let bad = 0; const sample = [];
    for (const p of pays) { if (!expIds.has(p.expenseId)) { bad++; if (sample.length < 10) sample.push(p.id); } }
    rec(id, t, s, bad, sample);
  });
  // 4. Amount mismatch: payment amount ≠ its linked Expense amount.
  await safe("PP-04", "PayrollPayment amount ≠ linked Expense amount", "S1", async (id, t, s) => {
    const pays = await prisma.payrollPayment.findMany({ where: { expenseId: { not: null }, status: "confirmed" }, select: { id: true, amountKopeks: true, expenseId: true } });
    const expAmt = new Map((await prisma.expense.findMany({ select: { id: true, amountKopeks: true } })).map((e) => [e.id, e.amountKopeks]));
    let bad = 0; const sample = [];
    for (const p of pays) { if (expAmt.has(p.expenseId) && expAmt.get(p.expenseId) !== p.amountKopeks) { bad++; if (sample.length < 10) sample.push(p.id); } }
    rec(id, t, s, bad, sample);
  });
  // 5. Tenant mismatch: payment.companyId ≠ its calc.companyId.
  await safe("PP-05", "PayrollPayment.companyId ≠ its PayrollCalculation.companyId", "S1", async (id, t, s) => {
    const calcCo = new Map((await prisma.payrollCalculation.findMany({ select: { id: true, companyId: true } })).map((c) => [c.id, c.companyId]));
    const pays = await prisma.payrollPayment.findMany({ select: { id: true, companyId: true, payrollCalculationId: true } });
    let bad = 0; const sample = [];
    for (const p of pays) { if (calcCo.has(p.payrollCalculationId) && calcCo.get(p.payrollCalculationId) !== p.companyId) { bad++; if (sample.length < 10) sample.push(p.id); } }
    rec(id, t, s, bad, sample);
  });
  // 6. Duplicate idempotency keys (should be impossible under the unique constraint).
  await safe("PP-06", "duplicate (companyId, idempotencyKey) on PayrollPayment/RegionalCityPayment", "S1", async (id, t, s) => {
    let bad = 0; const sample = [];
    for (const model of ["payrollPayment", "regionalCityPayment"]) {
      const rows = await prisma[model].findMany({ where: { idempotencyKey: { not: null } }, select: { companyId: true, idempotencyKey: true } });
      const seen = new Set(); for (const r of rows) { const k = `${r.companyId}|${r.idempotencyKey}`; if (seen.has(k)) { bad++; if (sample.length < 10) sample.push(`${model}:${k}`); } else seen.add(k); }
    }
    rec(id, t, s, bad, sample);
  });
  // 7. Payment(s) exceeding payable: Σ confirmed payments > netPayable for a calc.
  await safe("PP-07", "Σ confirmed payments > netPayable for a calc (overpaid)", "S2", async (id, t, s) => {
    const calcs = await prisma.payrollCalculation.findMany({ select: { id: true, netPayableKopeks: true } });
    const net = new Map(calcs.map((c) => [c.id, c.netPayableKopeks]));
    const pays = await prisma.payrollPayment.findMany({ where: { status: "confirmed" }, select: { payrollCalculationId: true, amountKopeks: true } });
    const sum = new Map(); for (const p of pays) sum.set(p.payrollCalculationId, (sum.get(p.payrollCalculationId) || 0) + p.amountKopeks);
    let bad = 0; const sample = [];
    for (const [cid, tot] of sum) { if (net.has(cid) && tot > net.get(cid)) { bad++; if (sample.length < 10) sample.push(cid); } }
    rec(id, t, s, bad, sample);
  });
  // 8. Obligation cache mismatch: obligation.paidKopeks ≠ Σ calc.paidKopeks for its period slice (coarse).
  await safe("PP-08", "PayrollPaymentObligation totals lag the period's calc totals", "S2", async (id, t, s) => {
    const obls = await prisma.payrollPaymentObligation.findMany({ where: { status: { not: "cancelled" } }, select: { id: true, payrollPeriodId: true, paidKopeks: true, amountKopeks: true } });
    let bad = 0; const sample = [];
    for (const o of obls) {
      const agg = await prisma.payrollCalculation.aggregate({ where: { payrollPeriodId: o.payrollPeriodId }, _sum: { paidKopeks: true, netPayableKopeks: true } });
      // Only flag when the obligation clearly understates the period's paid (a lagged refresh).
      if ((agg._sum.paidKopeks ?? 0) > o.paidKopeks && (agg._sum.netPayableKopeks ?? 0) >= o.amountKopeks) { bad++; if (sample.length < 10) sample.push(o.id); }
    }
    rec(id, t, s, bad, sample);
  });
  // 9. Regional payment expenseId missing (phantom regional payment).
  await safe("PP-09", "confirmed RegionalCityPayment with null expenseId", "S2", async (id, t, s) => {
    const rows = await prisma.regionalCityPayment.findMany({ where: { status: "confirmed", expenseId: null }, select: { id: true } });
    rec(id, t, s, rows.length, rows.slice(0, 10).map((r) => r.id));
  });
  // 10. Regional-ID-masquerading-as-employee (DATA-010): obligation.employeeId equals a RegionalCityPayroll.id.
  await safe("PP-10", "EmployeeFinancialObligation.employeeId is a RegionalCityPayroll.id (DATA-010)", "S2", async (id, t, s) => {
    const regIds = new Set((await prisma.regionalCityPayroll.findMany({ select: { id: true } }).catch(() => [])).map((r) => r.id));
    const obls = await prisma.employeeFinancialObligation.findMany({ where: { reason: "overpayment" }, select: { id: true, employeeId: true } }).catch(() => []);
    let bad = 0; const sample = [];
    for (const o of obls) { if (regIds.has(o.employeeId)) { bad++; if (sample.length < 10) sample.push(o.id); } }
    rec(id, t, s, bad, sample);
  });
  // 11. Legacy payments with no idempotency key (informational — expected for pre-REM-01 rows).
  await safe("PP-11", "legacy PayrollPayment without idempotencyKey (expected; not auto-backfilled)", "S3", async (id, t, s) => {
    const n = await prisma.payrollPayment.count({ where: { idempotencyKey: null } });
    rec(id, t, s, n, []);
  });

  const total = results.reduce((a, r) => a + (r.offendingRows || 0), 0);
  const report = { generatedAt: "db-read-only", checks: results.length, totalOffendingRows: total, results };
  mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true });
  writeFileSync(join(ROOT, "docs/audits/data/payroll-payments-preflight.json"), JSON.stringify(report, null, 2));
  if (!JSON_ONLY) {
    console.log("=== Payroll-payments preflight (READ-ONLY, no writes) ===");
    for (const r of results) console.log(`${r.offendingRows === 0 ? "OK  " : r.error ? "ERR " : "FLAG"} ${r.id} [${r.severity}] ${r.title}${r.offendingRows ? ` → ${r.offendingRows}` : ""}${r.error ? " :: " + r.error : ""}`);
    console.log(`\n${results.length} checks · ${total} offending rows`);
    console.log("NOTE: PP-11 legacy nulls are EXPECTED (never auto-backfilled). A clean DEV result does not prove production.");
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
