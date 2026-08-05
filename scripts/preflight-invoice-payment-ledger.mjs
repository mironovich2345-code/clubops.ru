// REM-08 — READ-ONLY invoice payment-ledger preflight (§21). SELECT-only; NO writes.
// Surfaces status/ledger inconsistencies + legacy ledgerless paid invoices (which stay
// recognized as expense per REM-05 but must NOT silently look "100% paid").
//   node --env-file=.env scripts/preflight-invoice-payment-ledger.mjs [--json]
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
const results = [];
const rec = (id, title, sev, action, count, amountKopeks = null, sample = []) => results.push({ id, title, severity: sev, recommendedAction: action, count, amountKopeks, sample: sample.slice(0, 8) });
const safe = async (id, title, sev, act, fn) => { try { await fn(id, title, sev, act); } catch (e) { results.push({ id, title, severity: sev, error: String(e.message || e).slice(0, 160), count: null }); } };

const RECOGNIZED = ["approved_by_regional", "approved_by_chief_accountant", "approved_by_owner", "partially_paid", "paid"];
const confirmedPaid = (pays) => pays.filter((p) => p.status === "confirmed").reduce((a, p) => a + p.amountKopeks, 0);

async function main() {
  const invoices = await prisma.invoice.findMany({ select: { id: true, companyId: true, clubId: true, legalEntityId: true, amountKopeks: true, status: true, paidAt: true, expensePeriod: true } });
  const payments = await prisma.invoicePayment.findMany({ select: { id: true, invoiceId: true, companyId: true, amountKopeks: true, status: true } });
  const byInvoice = new Map();
  for (const p of payments) { const l = byInvoice.get(p.invoiceId) ?? []; l.push(p); byInvoice.set(p.invoiceId, l); }
  const invIds = new Set(invoices.map((i) => i.id));
  const invById = new Map(invoices.map((i) => [i.id, i]));

  // 1/20. paid/partially_paid invoice with NO confirmed payments (legacy ledgerless).
  await safe("IPL-01", "paid/partially_paid invoice without confirmed payments (legacy ledger missing)", "S2", "manual reconciliation (create historical InvoicePayment or correct status)", async (id, t, s, a) => {
    const bad = invoices.filter((i) => ["paid", "partially_paid"].includes(i.status) && confirmedPaid(byInvoice.get(i.id) ?? []) === 0);
    rec(id, t, s, a, bad.length, bad.reduce((x, i) => x + i.amountKopeks, 0), bad.map((i) => i.id));
  });
  // 3. fully paid amount but stored status not paid.
  await safe("IPL-03", "confirmed paid >= total but status != paid", "S1", "re-sync status from ledger", async (id, t, s, a) => {
    const bad = invoices.filter((i) => { const p = confirmedPaid(byInvoice.get(i.id) ?? []); return p > 0 && p >= i.amountKopeks && i.status !== "paid"; });
    rec(id, t, s, a, bad.length, null, bad.map((i) => i.id));
  });
  // 2. partial paid amount but stored status unpaid/approved.
  await safe("IPL-02", "0 < confirmed paid < total but status not partially_paid", "S1", "re-sync status from ledger", async (id, t, s, a) => {
    const bad = invoices.filter((i) => { const p = confirmedPaid(byInvoice.get(i.id) ?? []); return p > 0 && p < i.amountKopeks && i.status !== "partially_paid"; });
    rec(id, t, s, a, bad.length, null, bad.map((i) => i.id));
  });
  // 4. overpaid (confirmed paid > total).
  await safe("IPL-04", "overpaid invoice (confirmed paid > total)", "S1", "reverse the excess payment", async (id, t, s, a) => {
    const bad = invoices.filter((i) => confirmedPaid(byInvoice.get(i.id) ?? []) > i.amountKopeks);
    rec(id, t, s, a, bad.length, bad.reduce((x, i) => x + (confirmedPaid(byInvoice.get(i.id) ?? []) - i.amountKopeks), 0), bad.map((i) => i.id));
  });
  // 6. duplicate idempotency key (should be impossible with @unique).
  await safe("IPL-06", "duplicate payment idempotency key", "S0", "investigate (constraint bypass)", async (id, t, s, a) => {
    const seen = new Map(); let bad = 0; const sample = [];
    for (const p of await prisma.invoicePayment.findMany({ where: { idempotencyKey: { not: null } }, select: { id: true, idempotencyKey: true } })) { if (seen.has(p.idempotencyKey)) { bad++; if (sample.length < 8) sample.push(p.id); } else seen.set(p.idempotencyKey, p.id); }
    rec(id, t, s, a, bad, null, sample);
  });
  // 7. payment without a live invoice (orphan).
  await safe("IPL-07", "payment referencing a missing invoice", "S1", "investigate orphan", async (id, t, s, a) => {
    const bad = payments.filter((p) => !invIds.has(p.invoiceId));
    rec(id, t, s, a, bad.length, null, bad.map((p) => p.id));
  });
  // 8. cross-company payment (payment.companyId != invoice.companyId).
  await safe("IPL-08", "cross-company payment (payment.company != invoice.company)", "S0", "investigate security", async (id, t, s, a) => {
    const bad = payments.filter((p) => { const inv = invById.get(p.invoiceId); return inv && inv.companyId !== p.companyId; });
    rec(id, t, s, a, bad.length, null, bad.map((p) => p.id));
  });
  // 12. paidAt set while not fully paid.
  await safe("IPL-12", "paidAt set while confirmed paid < total", "S2", "clear paidAt (partial is not fully paid)", async (id, t, s, a) => {
    const bad = invoices.filter((i) => i.paidAt && confirmedPaid(byInvoice.get(i.id) ?? []) < i.amountKopeks);
    rec(id, t, s, a, bad.length, null, bad.map((i) => i.id));
  });
  // 13. fully paid (by ledger) but paidAt missing.
  await safe("IPL-13", "confirmed paid >= total but paidAt missing", "S3", "set paidAt to the closing payment date", async (id, t, s, a) => {
    const bad = invoices.filter((i) => { const p = confirmedPaid(byInvoice.get(i.id) ?? []); return i.amountKopeks > 0 && p >= i.amountKopeks && !i.paidAt; });
    rec(id, t, s, a, bad.length, null, bad.map((i) => i.id));
  });
  // 16. payment amount zero/negative.
  await safe("IPL-16", "payment amount <= 0", "S1", "reverse/correct the payment", async (id, t, s, a) => {
    const bad = payments.filter((p) => p.amountKopeks <= 0);
    rec(id, t, s, a, bad.length, null, bad.map((p) => p.id));
  });
  // 17. confirmed payment on a rejected/cancelled invoice.
  await safe("IPL-17", "confirmed payment on a rejected/cancelled invoice", "S1", "reverse the payment or correct the invoice", async (id, t, s, a) => {
    const bad = payments.filter((p) => { const inv = invById.get(p.invoiceId); return p.status === "confirmed" && inv && ["rejected", "canceled", "cancelled"].includes(inv.status); });
    rec(id, t, s, a, bad.length, null, bad.map((p) => p.id));
  });
  // 18. status/ledger mismatch (stored vs derived).
  await safe("IPL-18", "invoice status does not match the ledger-derived state", "S1", "re-sync status from ledger", async (id, t, s, a) => {
    let bad = 0; const sample = [];
    for (const i of invoices) {
      const p = confirmedPaid(byInvoice.get(i.id) ?? []);
      const derived = i.amountKopeks > 0 && p >= i.amountKopeks ? "paid" : p > 0 ? "partially_paid" : null;
      if (derived && i.status !== derived) { bad++; if (sample.length < 8) sample.push(i.id); }
    }
    rec(id, t, s, a, bad, null, sample);
  });

  const summary = { note: "read-only invoice payment-ledger preflight (SELECT only)", totals: { invoices: invoices.length, payments: payments.length }, checks: results };
  try { mkdirSync(join(ROOT, "docs/audits/data"), { recursive: true }); writeFileSync(join(ROOT, "docs/audits/data/invoice-payment-ledger-preflight.json"), JSON.stringify(summary, null, 2)); } catch { /* best effort */ }
  if (JSON_ONLY) console.log(JSON.stringify(summary, null, 2));
  else { console.log(`Invoice payment-ledger preflight — ${invoices.length} invoices, ${payments.length} payments`); for (const c of results) console.log(`  ${c.severity} ${c.id} ${c.title}: ${c.count}${c.amountKopeks != null ? ` (${(c.amountKopeks / 100).toLocaleString("ru")} ₽)` : ""}${c.error ? " ERR:" + c.error : ""}`); }
  const blocking = results.filter((c) => c.severity === "S0" && c.count > 0);
  await prisma.$disconnect();
  process.exit(blocking.length ? 2 : 0);
}
main().catch(async (e) => { console.error("preflight failed:", String(e.message || e).slice(0, 200)); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
