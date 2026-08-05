// REM-08 — READ-ONLY invoice-payment reconciliation (§22). Per-invoice: total,
// confirmed paid, reversed, remaining, derived payment state vs stored status, legacy
// ledgerless warning. SELECT-only; NO writes, NO corrections.
//   node --env-file=.env scripts/reconcile-invoice-payments.mjs [--company=ID] [--invoice=ID] [--month=YYYY-MM] [--mismatch-only] [--json]
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const arg = (n) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : null; };
const JSON_ONLY = process.argv.includes("--json");
const MISMATCH_ONLY = process.argv.includes("--mismatch-only");

const confirmedPaid = (pays) => pays.filter((p) => p.status === "confirmed").reduce((a, p) => a + p.amountKopeks, 0);
const reversedSum = (pays) => pays.filter((p) => p.status === "reversed").reduce((a, p) => a + p.amountKopeks, 0);

async function main() {
  const where = {};
  if (arg("company")) where.companyId = arg("company");
  if (arg("invoice")) where.id = arg("invoice");
  if (arg("month")) where.expensePeriod = arg("month");
  const invoices = await prisma.invoice.findMany({ where, select: { id: true, companyId: true, clubId: true, legalEntityId: true, amountKopeks: true, status: true, paidAt: true, expensePeriod: true } });
  const ids = invoices.map((i) => i.id);
  const payments = ids.length ? await prisma.invoicePayment.findMany({ where: { invoiceId: { in: ids } }, select: { invoiceId: true, amountKopeks: true, status: true } }) : [];
  const byInvoice = new Map();
  for (const p of payments) { const l = byInvoice.get(p.invoiceId) ?? []; l.push(p); byInvoice.set(p.invoiceId, l); }

  const rows = [];
  let mismatches = 0, ledgerless = 0;
  for (const i of invoices) {
    const pays = byInvoice.get(i.id) ?? [];
    const paid = confirmedPaid(pays);
    const reversed = reversedSum(pays);
    const remaining = Math.max(i.amountKopeks - paid, 0);
    const derived = i.amountKopeks > 0 && paid >= i.amountKopeks ? "paid" : paid > 0 ? "partially_paid" : "unpaid";
    // "unpaid" derived maps to the stored approved-unpaid statuses; only compare paid/partial.
    const storedPaidClass = i.status === "paid" ? "paid" : i.status === "partially_paid" ? "partially_paid" : "unpaid";
    const mismatch = (derived === "paid" && storedPaidClass !== "paid") || (derived === "partially_paid" && storedPaidClass !== "partially_paid") || (derived === "unpaid" && storedPaidClass !== "unpaid");
    const legacyWarning = ["paid", "partially_paid"].includes(i.status) && paid === 0 ? "legacy_ledger_missing" : null;
    if (mismatch) mismatches++;
    if (legacyWarning) ledgerless++;
    if (MISMATCH_ONLY && !mismatch && !legacyWarning) continue;
    rows.push({ invoiceId: i.id, companyId: i.companyId, expensePeriod: i.expensePeriod, totalKopeks: i.amountKopeks, confirmedPaidKopeks: paid, reversedKopeks: reversed, remainingKopeks: remaining, derivedState: derived, storedStatus: i.status, paidAt: i.paidAt ? i.paidAt.toISOString().slice(0, 10) : null, mismatch, legacyWarning, paymentRows: pays.length });
  }

  const out = { note: "read-only; ledger vs stored status; no corrections", totals: { invoices: invoices.length, mismatches, ledgerless }, rows: JSON_ONLY ? rows : rows.slice(0, 60) };
  if (JSON_ONLY) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`Invoice-payment reconciliation — ${invoices.length} invoice(s), ${mismatches} mismatch, ${ledgerless} legacy-ledgerless`);
    for (const r of rows.slice(0, 40)) console.log(`  ${r.invoiceId}  total=${(r.totalKopeks / 100).toLocaleString("ru")}  paid=${(r.confirmedPaidKopeks / 100).toLocaleString("ru")}  remain=${(r.remainingKopeks / 100).toLocaleString("ru")}  derived=${r.derivedState} stored=${r.storedStatus}${r.mismatch ? " ⚠MISMATCH" : ""}${r.legacyWarning ? " ⚠" + r.legacyWarning : ""}`);
    if (!rows.length) console.log("  (no rows)");
  }
  await prisma.$disconnect();
  process.exit(0);
}
main().catch(async (e) => { console.error("reconcile failed:", String(e.message || e).slice(0, 200)); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
