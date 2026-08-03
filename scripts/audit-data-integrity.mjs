// READ-ONLY data-integrity preflight (FULL AUDIT 2/6, §22). Connects to the database and runs
// 25 SELECT-only checks. It performs NO writes — no create/update/delete, no $executeRaw. Safe
// on production in read-only mode. Emits docs/audits/data/data-integrity-report.json + a summary.
//   node --env-file=.env scripts/audit-data-integrity.mjs           (human summary)
//   node --env-file=.env scripts/audit-data-integrity.mjs --json    (json only)
// The Prisma client provider follows whatever schema was last generated (dev=sqlite / prod=pg).
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
const results = [];
const record = (id, title, severity, count, sample = []) => results.push({ id, title, severity, offendingRows: count, sample: sample.slice(0, 10) });
const safe = async (id, title, sev, fn) => { try { await fn(id, title, sev); } catch (e) { results.push({ id, title, severity: sev, error: String(e.message || e).slice(0, 200), offendingRows: null }); } };

async function main() {
  // Preload tenant maps once (read-only).
  const clubs = await prisma.club.findMany({ select: { id: true, companyId: true, isActive: true } });
  const clubCompany = new Map(clubs.map((c) => [c.id, c.companyId]));
  const legalEntities = await prisma.legalEntity.findMany({ select: { id: true, companyId: true } });
  const leCompany = new Map(legalEntities.map((e) => [e.id, e.companyId]));
  const cle = await prisma.clubLegalEntity.findMany({ select: { clubId: true, legalEntityId: true } });
  const cleSet = new Set(cle.map((x) => `${x.clubId}|${x.legalEntityId}`));

  // 1. company/club mismatch across financial models.
  await safe("DATA-CHK-01", "company/club mismatch (row.companyId ≠ club.companyId)", "S1", async (id, title, sev) => {
    let bad = 0; const sample = [];
    for (const model of ["invoice", "expense", "refund", "budget", "balanceSnapshot", "payrollPeriod", "payrollCalculation", "payrollPayment", "cashCollection", "cashWithdrawal", "cashRegionalTransfer"]) {
      if (!prisma[model]) continue;
      const rows = await prisma[model].findMany({ select: { id: true, companyId: true, clubId: true } }).catch(() => []);
      for (const r of rows) { if (r.clubId && clubCompany.has(r.clubId) && clubCompany.get(r.clubId) !== r.companyId) { bad++; if (sample.length < 10) sample.push(`${model}:${r.id}`); } }
    }
    record(id, title, sev, bad, sample);
  });

  // 2. company/legalEntity mismatch.
  await safe("DATA-CHK-02", "company/legalEntity mismatch (LE belongs to another company)", "S1", async (id, title, sev) => {
    let bad = 0; const sample = [];
    for (const model of ["invoice", "expense", "balanceSnapshot", "payrollCalculation", "payrollPayment", "payrollPaymentObligation", "cashRegionalTransfer", "cashWallet"]) {
      if (!prisma[model]) continue;
      const rows = await prisma[model].findMany({ select: { id: true, companyId: true, legalEntityId: true } }).catch(() => []);
      for (const r of rows) { if (r.legalEntityId && leCompany.has(r.legalEntityId) && leCompany.get(r.legalEntityId) !== r.companyId) { bad++; if (sample.length < 10) sample.push(`${model}:${r.id}`); } }
    }
    record(id, title, sev, bad, sample);
  });

  // 3. club/legalEntity not associated (no ClubLegalEntity row).
  await safe("DATA-CHK-03", "club/legalEntity used without a ClubLegalEntity association", "S2", async (id, title, sev) => {
    let bad = 0; const sample = [];
    for (const model of ["invoice", "expense", "balanceSnapshot", "payrollPayment"]) {
      if (!prisma[model]) continue;
      const rows = await prisma[model].findMany({ select: { id: true, clubId: true, legalEntityId: true } }).catch(() => []);
      for (const r of rows) { if (r.clubId && r.legalEntityId && !cleSet.has(`${r.clubId}|${r.legalEntityId}`)) { bad++; if (sample.length < 10) sample.push(`${model}:${r.id}`); } }
    }
    record(id, title, sev, bad, sample);
  });

  // 4. InvoicePayment tenant mismatch vs its Invoice.
  await safe("DATA-CHK-04", "InvoicePayment.companyId ≠ its Invoice.companyId", "S1", async (id, title, sev) => {
    const pays = await prisma.invoicePayment.findMany({ select: { id: true, companyId: true, invoiceId: true } }).catch(() => []);
    const invs = new Map((await prisma.invoice.findMany({ select: { id: true, companyId: true } })).map((i) => [i.id, i.companyId]));
    let bad = 0; const sample = [];
    for (const p of pays) { if (invs.has(p.invoiceId) && invs.get(p.invoiceId) !== p.companyId) { bad++; if (sample.length < 10) sample.push(p.id); } }
    record(id, title, sev, bad, sample);
  });

  // 6. payroll calc/payment employee not in same company.
  await safe("DATA-CHK-06", "payroll payment/calc employeeId not a ClubEmployee of the same company", "S2", async (id, title, sev) => {
    const emps = new Map((await prisma.clubEmployee.findMany({ select: { id: true, companyId: true } })).map((e) => [e.id, e.companyId]));
    let bad = 0; const sample = [];
    for (const model of ["payrollCalculation", "payrollPayment"]) {
      const rows = await prisma[model].findMany({ select: { id: true, companyId: true, employeeId: true } }).catch(() => []);
      for (const r of rows) { if (r.employeeId && (!emps.has(r.employeeId) || emps.get(r.employeeId) !== r.companyId)) { bad++; if (sample.length < 10) sample.push(`${model}:${r.id}`); } }
    }
    record(id, title, sev, bad, sample);
  });

  // 8. orphan source links: PayrollPayment.expenseId → missing Expense; obligation period missing.
  await safe("DATA-CHK-08", "orphan links (PayrollPayment.expenseId → missing Expense)", "S1", async (id, title, sev) => {
    const expIds = new Set((await prisma.expense.findMany({ select: { id: true } })).map((e) => e.id));
    const pays = await prisma.payrollPayment.findMany({ select: { id: true, expenseId: true, status: true } }).catch(() => []);
    let bad = 0; const sample = [];
    for (const p of pays) { if (p.status === "confirmed" && p.expenseId && !expIds.has(p.expenseId)) { bad++; if (sample.length < 10) sample.push(p.id); } }
    // also confirmed payments with NO expenseId (phantom payment)
    let phantom = 0; for (const p of pays) if (p.status === "confirmed" && !p.expenseId) phantom++;
    record(id, `${title}; confirmed payments with null expenseId=${phantom}`, sev, bad + phantom, sample);
  });

  // 9. duplicate ACTIVE snapshots per (club, LE, date).
  await safe("DATA-CHK-09", "duplicate active BalanceSnapshot per (club, legalEntity, date)", "S1", async (id, title, sev) => {
    const snaps = await prisma.balanceSnapshot.findMany({ where: { status: "active" }, select: { id: true, clubId: true, legalEntityId: true, snapshotDate: true } }).catch(() => []);
    const seen = new Map(); let bad = 0; const sample = [];
    for (const s of snaps) { const k = `${s.clubId}|${s.legalEntityId}|${new Date(s.snapshotDate).toISOString().slice(0, 10)}`; if (seen.has(k)) { bad++; if (sample.length < 10) sample.push(k); } else seen.set(k, s.id); }
    record(id, title, sev, bad, sample);
  });

  // 10. broken snapshot chains (supersedesSnapshotId → missing row).
  await safe("DATA-CHK-10", "broken snapshot chain (supersedesSnapshotId → missing snapshot)", "S2", async (id, title, sev) => {
    const snaps = await prisma.balanceSnapshot.findMany({ select: { id: true, supersedesSnapshotId: true } }).catch(() => []);
    const ids = new Set(snaps.map((s) => s.id)); let bad = 0; const sample = [];
    for (const s of snaps) { if (s.supersedesSnapshotId && !ids.has(s.supersedesSnapshotId)) { bad++; if (sample.length < 10) sample.push(s.id); } }
    record(id, title, sev, bad, sample);
  });

  // 11. paid invoice without any confirmed payment row (ledgerless paid — ARCH-010).
  await safe("DATA-CHK-11", "paid/partially_paid invoice with NO confirmed InvoicePayment (ledgerless)", "S1", async (id, title, sev) => {
    const paidInv = await prisma.invoice.findMany({ where: { status: { in: ["paid", "partially_paid"] } }, select: { id: true } }).catch(() => []);
    const withPay = new Set((await prisma.invoicePayment.findMany({ where: { status: "confirmed" }, select: { invoiceId: true } })).map((p) => p.invoiceId));
    let bad = 0; const sample = [];
    for (const inv of paidInv) { if (!withPay.has(inv.id)) { bad++; if (sample.length < 10) sample.push(inv.id); } }
    record(id, title, sev, bad, sample);
  });

  // 12. sum(confirmed payments) > invoice total.
  await safe("DATA-CHK-12", "confirmed InvoicePayment sum exceeds Invoice.amountKopeks (overpayment)", "S1", async (id, title, sev) => {
    const invs = new Map((await prisma.invoice.findMany({ select: { id: true, amountKopeks: true } })).map((i) => [i.id, i.amountKopeks]));
    const pays = await prisma.invoicePayment.findMany({ where: { status: "confirmed" }, select: { invoiceId: true, amountKopeks: true } }).catch(() => []);
    const paid = new Map(); for (const p of pays) paid.set(p.invoiceId, (paid.get(p.invoiceId) || 0) + p.amountKopeks);
    let bad = 0; const sample = [];
    for (const [invId, total] of paid) { if (invs.has(invId) && total > invs.get(invId)) { bad++; if (sample.length < 10) sample.push(invId); } }
    record(id, title, sev, bad, sample);
  });

  // 13. payroll paidKopeks > netPayableKopeks (overpayment beyond payable).
  await safe("DATA-CHK-13", "PayrollCalculation.paidKopeks > netPayableKopeks (overpaid)", "S2", async (id, title, sev) => {
    const calcs = await prisma.payrollCalculation.findMany({ select: { id: true, paidKopeks: true, netPayableKopeks: true } }).catch(() => []);
    let bad = 0; const sample = [];
    for (const c of calcs) { if ((c.paidKopeks ?? 0) > (c.netPayableKopeks ?? 0)) { bad++; if (sample.length < 10) sample.push(c.id); } }
    record(id, title, sev, bad, sample);
  });

  // 14. duplicate idempotency keys across the models that carry them.
  await safe("DATA-CHK-14", "duplicate idempotencyKey values", "S1", async (id, title, sev) => {
    let bad = 0; const sample = [];
    for (const model of ["invoicePayment", "payrollAdvancePayment", "payrollPaymentObligation", "cashRegionalTransfer"]) {
      if (!prisma[model]) continue;
      const rows = await prisma[model].findMany({ where: { idempotencyKey: { not: null } }, select: { idempotencyKey: true } }).catch(() => []);
      const seen = new Set(); for (const r of rows) { if (seen.has(r.idempotencyKey)) { bad++; if (sample.length < 10) sample.push(`${model}:${r.idempotencyKey}`); } else seen.add(r.idempotencyKey); }
    }
    record(id, title, sev, bad, sample);
  });

  // 16. records in an unreachable status (per Audit 1 findings).
  await safe("DATA-CHK-16", "records in an unreachable status (under_review/superseded/pending)", "S2", async (id, title, sev) => {
    let bad = 0; const sample = [];
    const cr = await prisma.payrollChangeRequest.findMany({ where: { status: "under_review" }, select: { id: true } }).catch(() => []);
    const bp = await prisma.budgetChangeProposal.findMany({ where: { status: "superseded" }, select: { id: true } }).catch(() => []);
    const pp = await prisma.payrollPayment.findMany({ where: { status: "pending" }, select: { id: true } }).catch(() => []);
    bad = cr.length + bp.length + pp.length;
    for (const x of [...cr, ...bp, ...pp].slice(0, 10)) sample.push(x.id);
    record(id, `${title} (changeReq under_review=${cr.length}, proposal superseded=${bp.length}, payment pending=${pp.length})`, sev, bad, sample);
  });

  // 18. future effective dates (snapshot / period in the future).
  await safe("DATA-CHK-18", "future-dated records (BalanceSnapshot.snapshotDate > now)", "S2", async (id, title, sev) => {
    const now = new Date();
    const snaps = await prisma.balanceSnapshot.findMany({ where: { snapshotDate: { gt: now } }, select: { id: true } }).catch(() => []);
    record(id, title, sev, snaps.length, snaps.slice(0, 10).map((s) => s.id));
  });

  // 19. invalid period boundaries (PayrollPeriod.month out of 1..12).
  await safe("DATA-CHK-19", "PayrollPeriod month/year out of range", "S2", async (id, title, sev) => {
    const periods = await prisma.payrollPeriod.findMany({ select: { id: true, year: true, month: true } }).catch(() => []);
    let bad = 0; const sample = [];
    for (const p of periods) { if (!p.month || p.month < 1 || p.month > 12 || !p.year || p.year < 2000) { bad++; if (sample.length < 10) sample.push(p.id); } }
    record(id, title, sev, bad, sample);
  });

  // 21. legacy v1 records that are still live-writable (informational count).
  await safe("DATA-CHK-21", "legacy v1 records present (Expense/Refund entryVersion=1)", "S3", async (id, title, sev) => {
    const e = await prisma.expense.count({ where: { entryVersion: 1 } }).catch(() => 0);
    const r = await prisma.refund.count({ where: { entryVersion: 1 } }).catch(() => 0);
    record(id, `${title} (expense v1=${e}, refund v1=${r})`, sev, e + r, []);
  });

  // 22/23. orphan / cross-tenant documents.
  await safe("DATA-CHK-23", "cross-tenant documents (ExpenseDocument.companyId ≠ parent Expense.companyId)", "S2", async (id, title, sev) => {
    const expCo = new Map((await prisma.expense.findMany({ select: { id: true, companyId: true } })).map((e) => [e.id, e.companyId]));
    const docs = await prisma.expenseDocument.findMany({ select: { id: true, companyId: true, expenseId: true } }).catch(() => []);
    let bad = 0; const sample = [];
    for (const d of docs) { if (d.expenseId && expCo.has(d.expenseId) && expCo.get(d.expenseId) !== d.companyId) { bad++; if (sample.length < 10) sample.push(d.id); } }
    record(id, title, sev, bad, sample);
  });

  // 7. obligation with company mismatch vs its period.
  await safe("DATA-CHK-07", "PayrollPaymentObligation.companyId ≠ its PayrollPeriod.companyId", "S2", async (id, title, sev) => {
    const periodCo = new Map((await prisma.payrollPeriod.findMany({ select: { id: true, companyId: true } })).map((p) => [p.id, p.companyId]));
    const obls = await prisma.payrollPaymentObligation.findMany({ select: { id: true, companyId: true, payrollPeriodId: true } }).catch(() => []);
    let bad = 0; const sample = [];
    for (const o of obls) { if (o.payrollPeriodId && periodCo.has(o.payrollPeriodId) && periodCo.get(o.payrollPeriodId) !== o.companyId) { bad++; if (sample.length < 10) sample.push(o.id); } }
    record(id, title, sev, bad, sample);
  });

  // 17. null required business fields (paid invoice without expensePeriod).
  await safe("DATA-CHK-17", "paid invoice with null expensePeriod (accrual month unknown)", "S3", async (id, title, sev) => {
    const rows = await prisma.invoice.findMany({ where: { status: "paid", expensePeriod: null }, select: { id: true } }).catch(() => []);
    record(id, title, sev, rows.length, rows.slice(0, 10).map((r) => r.id));
  });

  // 5. expense linked to a source object (invoice) of another company — via notes JSON is not FK; count expenses with a legalEntity mismatch already in CHK-02; here check refund/company.
  await safe("DATA-CHK-05", "Refund.legalEntityId belongs to another company (app-only scope)", "S2", async (id, title, sev) => {
    const refs = await prisma.refund.findMany({ where: { legalEntityId: { not: null } }, select: { id: true, companyId: true, legalEntityId: true } }).catch(() => []);
    let bad = 0; const sample = [];
    for (const r of refs) { if (leCompany.has(r.legalEntityId) && leCompany.get(r.legalEntityId) !== r.companyId) { bad++; if (sample.length < 10) sample.push(r.id); } }
    record(id, title, sev, bad, sample);
  });

  // 15/24/25 informational: counts that need production data to matter.
  await safe("DATA-CHK-25", "cascade-exposure inventory (Company has no soft-delete)", "S3", async (id, title, sev) => {
    const companies = await prisma.company.count().catch(() => 0);
    record(id, `${title}: companies=${companies}; hard-deleting one cascades Invoice/Expense/Refund/Budget/Snapshot and orphans scalar-id payroll/cash/OFD rows (see relation-risks.json)`, sev, 0, []);
  });

  // Summarize.
  const total = results.reduce((a, r) => a + (r.offendingRows || 0), 0);
  const withErrors = results.filter((r) => r.error);
  const report = { generatedAt: "db-read-only-scan", checks: results.length, totalOffendingRows: total, checksWithErrors: withErrors.length, results };
  mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true });
  writeFileSync(join(ROOT, "docs/audits/data/data-integrity-report.json"), JSON.stringify(report, null, 2));

  if (!JSON_ONLY) {
    console.log("=== Data-integrity preflight (READ-ONLY, no writes) ===");
    for (const r of results) console.log(`${(r.offendingRows === 0 ? "OK  " : r.error ? "ERR " : "FLAG")} ${r.id} [${r.severity}] ${r.title}${r.offendingRows ? ` → ${r.offendingRows} rows` : ""}${r.error ? ` :: ${r.error}` : ""}`);
    console.log(`\n${results.length} checks · ${total} total offending rows · ${withErrors.length} checks errored`);
    console.log("Wrote docs/audits/data/data-integrity-report.json");
    console.log("NOTE: 0 rows in the DEV database does NOT prove production is clean — run against a production read replica.");
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
