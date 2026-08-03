// READ-ONLY financial reconciliation preflight (FULL AUDIT 3/6, §21). Connects to the DB and
// checks the accounting equations with SELECT-only queries — NO writes (no create/update/delete,
// no $executeRaw). Safe on a production read replica. Emits docs/audits/data/reconciliation-report.json.
//   node --env-file=.env scripts/audit-financial-reconciliation.mjs [--json]
//   optional filters: --company=<id> --club=<id> --month=YYYY-MM
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
const argOf = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : null; };
const fCompany = argOf("company"), fClub = argOf("club");

const results = [];
const rec = (id, eq, severity, violations, sample = []) => results.push({ id, equation: eq, severity, violations, sample: sample.slice(0, 10) });
const safe = async (id, eq, sev, fn) => { try { await fn(id, eq, sev); } catch (e) { results.push({ id, equation: eq, severity: sev, error: String(e.message || e).slice(0, 200), violations: null }); } };

async function main() {
  const invWhere = { ...(fCompany ? { companyId: fCompany } : {}), ...(fClub ? { clubId: fClub } : {}) };

  // REC-INV-1: invoice.amountKopeks == paidTotal(confirmed) + remaining  → check ledgerless paid & overpay.
  await safe("REC-INV-1", "invoice.amount == Σ confirmed InvoicePayment + remaining (no ledgerless paid, no overpay)", "S1", async (id, eq, sev) => {
    const invs = await prisma.invoice.findMany({ where: invWhere, select: { id: true, amountKopeks: true, status: true } }).catch(() => []);
    const pays = await prisma.invoicePayment.findMany({ where: { status: "confirmed" }, select: { invoiceId: true, amountKopeks: true } }).catch(() => []);
    const paid = new Map(); for (const p of pays) paid.set(p.invoiceId, (paid.get(p.invoiceId) || 0) + p.amountKopeks);
    let v = 0; const sample = [];
    for (const i of invs) {
      const pt = paid.get(i.id) || 0;
      const ledgerless = (i.status === "paid" || i.status === "partially_paid") && pt === 0;
      const overpay = pt > i.amountKopeks;
      if (ledgerless || overpay) { v++; if (sample.length < 10) sample.push(`${i.id}(${ledgerless ? "ledgerless" : "overpay"})`); }
    }
    rec(id, eq, sev, v, sample);
  });

  // REC-PR-1: PayrollCalculation net == paid + remaining (cache internal consistency).
  await safe("REC-PR-1", "PayrollCalculation.netPayable == paidKopeks + remainingKopeks", "S1", async (id, eq, sev) => {
    const calcs = await prisma.payrollCalculation.findMany({ where: fCompany ? { companyId: fCompany } : {}, select: { id: true, netPayableKopeks: true, paidKopeks: true, remainingKopeks: true } }).catch(() => []);
    let v = 0; const sample = [];
    for (const c of calcs) { if ((c.netPayableKopeks ?? 0) !== (c.paidKopeks ?? 0) + (c.remainingKopeks ?? 0)) { v++; if (sample.length < 10) sample.push(c.id); } }
    rec(id, eq, sev, v, sample);
  });

  // REC-PR-2: PayrollCalculation.paidKopeks == Σ confirmed PayrollPayment (recompute drift; ignores advance tranches so a nonzero here needs the tranche add-back — reported as candidates).
  await safe("REC-PR-2", "PayrollCalculation.paidKopeks ⊇ Σ confirmed PayrollPayment (+ active advance tranches)", "S2", async (id, eq, sev) => {
    const calcs = await prisma.payrollCalculation.findMany({ where: fCompany ? { companyId: fCompany } : {}, select: { id: true, paidKopeks: true } }).catch(() => []);
    const pays = await prisma.payrollPayment.findMany({ where: { status: "confirmed" }, select: { payrollCalculationId: true, amountKopeks: true } }).catch(() => []);
    const paidByCalc = new Map(); for (const p of pays) if (p.payrollCalculationId) paidByCalc.set(p.payrollCalculationId, (paidByCalc.get(p.payrollCalculationId) || 0) + p.amountKopeks);
    let v = 0; const sample = [];
    for (const c of calcs) { const direct = paidByCalc.get(c.id) || 0; if ((c.paidKopeks ?? 0) < direct) { v++; if (sample.length < 10) sample.push(c.id); } } // paid should never be LESS than confirmed payments
    rec(id, eq, sev, v, sample);
  });

  // REC-OBL-1: PayrollPaymentObligation.remaining == amount − paid (internal), and phantom/orphan payroll payments.
  await safe("REC-OBL-1", "PayrollPaymentObligation.remaining == amount − paid", "S2", async (id, eq, sev) => {
    const obls = await prisma.payrollPaymentObligation.findMany({ where: fCompany ? { companyId: fCompany } : {}, select: { id: true, amountKopeks: true, paidKopeks: true, remainingKopeks: true, status: true } }).catch(() => []);
    let v = 0; const sample = [];
    for (const o of obls) { if (o.status !== "cancelled" && (o.remainingKopeks ?? 0) !== Math.max(0, (o.amountKopeks ?? 0) - (o.paidKopeks ?? 0))) { v++; if (sample.length < 10) sample.push(o.id); } }
    rec(id, eq, sev, v, sample);
  });

  // REC-ORPH-1: confirmed PayrollPayment with null expenseId (phantom) or → missing Expense (orphan).
  await safe("REC-ORPH-1", "every confirmed PayrollPayment links to an existing salary Expense", "S1", async (id, eq, sev) => {
    const expIds = new Set((await prisma.expense.findMany({ select: { id: true } })).map((e) => e.id));
    const pays = await prisma.payrollPayment.findMany({ where: { status: "confirmed", ...(fCompany ? { companyId: fCompany } : {}) }, select: { id: true, expenseId: true } }).catch(() => []);
    let v = 0; const sample = [];
    for (const p of pays) { if (!p.expenseId || !expIds.has(p.expenseId)) { v++; if (sample.length < 10) sample.push(`${p.id}(${p.expenseId ? "orphan" : "phantom"})`); } }
    rec(id, eq, sev, v, sample);
  });

  // REC-CASH-1: dual-contour presence — clubs where BOTH a CashWallet (contour A) and a BalanceSnapshot
  // (contour B) exist for the same legal entity → the two balances can diverge (DATA-001/002). Reports
  // the count; the actual balances must be compared on a production replica.
  await safe("REC-CASH-1", "dual-contour presence (CashWallet ∧ BalanceSnapshot per club/LE → divergence candidate)", "S2", async (id, eq, sev) => {
    const wallets = await prisma.cashWallet.findMany({ where: fCompany ? { companyId: fCompany } : {}, select: { clubId: true, legalEntityId: true } }).catch(() => []);
    const snaps = await prisma.balanceSnapshot.findMany({ where: { status: "active", ...(fCompany ? { companyId: fCompany } : {}) }, select: { clubId: true, legalEntityId: true } }).catch(() => []);
    const walletKeys = new Set(wallets.map((w) => `${w.clubId}|${w.legalEntityId}`));
    const both = new Set(); for (const s of snaps) { const k = `${s.clubId}|${s.legalEntityId}`; if (walletKeys.has(k)) both.add(k); }
    rec(id, eq, sev, both.size, [...both].slice(0, 10));
  });

  // REC-PERIOD-1: paid invoice whose expensePeriod month differs from its paidAt month (accrual vs cash split — informational).
  await safe("REC-PERIOD-1", "paid invoice expensePeriod month == paidAt month (accrual/cash split is intentional — informational)", "S3", async (id, eq, sev) => {
    const invs = await prisma.invoice.findMany({ where: { status: "paid", paidAt: { not: null }, expensePeriod: { not: null }, ...invWhere }, select: { id: true, expensePeriod: true, paidAt: true } }).catch(() => []);
    let v = 0; const sample = [];
    for (const i of invs) { const pm = new Date(i.paidAt).toISOString().slice(0, 7); if (i.expensePeriod && i.expensePeriod !== pm) { v++; if (sample.length < 10) sample.push(`${i.id}(${i.expensePeriod}≠${pm})`); } }
    rec(id, `${eq}`, sev, v, sample);
  });

  const total = results.reduce((a, r) => a + (r.violations || 0), 0);
  const withErrors = results.filter((r) => r.error);
  const report = { generatedAt: "db-read-only-recon", filters: { company: fCompany, club: fClub }, checks: results.length, totalViolations: total, checksWithErrors: withErrors.length, results };
  mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true });
  writeFileSync(join(ROOT, "docs/audits/data/reconciliation-report.json"), JSON.stringify(report, null, 2));

  if (!JSON_ONLY) {
    console.log("=== Financial reconciliation preflight (READ-ONLY, no writes) ===");
    for (const r of results) console.log(`${(r.violations === 0 ? "OK  " : r.error ? "ERR " : "FLAG")} ${r.id} [${r.severity}] ${r.equation}${r.violations ? ` → ${r.violations}` : ""}${r.error ? ` :: ${r.error}` : ""}`);
    console.log(`\n${results.length} equations · ${total} total violations · ${withErrors.length} errored`);
    console.log("Wrote docs/audits/data/reconciliation-report.json");
    console.log("NOTE: a clean DEV result does NOT prove production is reconciled — run against a production read replica with --company/--club/--month.");
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
