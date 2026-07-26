// Read-only audit of legacy DRAFT expenses/invoices/refunds before the direct-submit
// migration. Counts + technical IDs only — no PII, no secrets. Buckets each draft into
// "ready to auto-submit to regional" vs "manual review" (spec §8/§10).
//   node scripts/finance-direct-submit-audit.mjs
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function hasRegional(companyId, clubId) {
  const [club, company] = await Promise.all([
    clubId ? p.clubUserAccess.count({ where: { clubId, role: "regional_director", user: { isActive: true } } }) : 0,
    companyId ? p.companyUserAccess.count({ where: { companyId, role: "regional_director", user: { isActive: true } } }) : 0,
  ]);
  return club > 0 || company > 0;
}
async function creatorIsRegional(userId, clubId) {
  if (!userId || !clubId) return false;
  return (await p.clubUserAccess.count({ where: { userId, clubId, role: "regional_director" } })) > 0;
}

async function auditExpenses() {
  const drafts = await p.expense.findMany({ where: { entryVersion: 2, status: "draft" }, select: { id: true, companyId: true, clubId: true, createdByUserId: true } });
  const b = { total: drafts.length, ready: 0, no_docs: 0, no_regional: 0, no_scope: 0, regional_created: 0, manual: [] };
  for (const e of drafts) {
    if (!e.companyId || !e.clubId) { b.no_scope++; b.manual.push(e.id); continue; }
    const docs = await p.expenseDocument.count({ where: { expenseId: e.id, removedAt: null } });
    if (docs < 1) { b.no_docs++; b.manual.push(e.id); continue; }
    if (await creatorIsRegional(e.createdByUserId, e.clubId)) { b.regional_created++; b.manual.push(e.id); continue; }
    if (!(await hasRegional(e.companyId, e.clubId))) { b.no_regional++; b.manual.push(e.id); continue; }
    b.ready++;
  }
  return b;
}

async function auditInvoices() {
  const drafts = await p.invoice.findMany({ where: { status: "draft" }, select: { id: true, companyId: true, clubId: true, originalFileStorageKey: true, counterpartyName: true, amountKopeks: true } });
  const b = { total: drafts.length, ready: 0, no_file: 0, no_data: 0, no_scope: 0, manual: [] };
  for (const inv of drafts) {
    if (!inv.companyId || !inv.clubId) { b.no_scope++; b.manual.push(inv.id); continue; }
    if (!inv.originalFileStorageKey) { b.no_file++; b.manual.push(inv.id); continue; }
    if (!inv.counterpartyName || !(inv.amountKopeks > 0)) { b.no_data++; b.manual.push(inv.id); continue; }
    b.ready++;
  }
  return b;
}

async function auditRefunds() {
  const drafts = await p.refund.findMany({ where: { entryVersion: 2, status: "draft" }, select: { id: true, companyId: true, clubId: true, clientName: true, refundResultAmountKopeks: true } });
  const b = { total: drafts.length, ready: 0, incomplete_docs: 0, no_client: 0, bad_calc: 0, no_scope: 0, manual: [] };
  for (const r of drafts) {
    if (!r.companyId || !r.clubId) { b.no_scope++; b.manual.push(r.id); continue; }
    if (!r.clientName) { b.no_client++; b.manual.push(r.id); continue; }
    if (!(r.refundResultAmountKopeks > 0)) { b.bad_calc++; b.manual.push(r.id); continue; }
    const active = await p.refundDocument.findMany({ where: { refundId: r.id, removedAt: null }, select: { documentType: true } });
    if (new Set(active.map((d) => d.documentType)).size < 4) { b.incomplete_docs++; b.manual.push(r.id); continue; }
    b.ready++;
  }
  return b;
}

async function main() {
  const [exp, inv, ref] = [await auditExpenses(), await auditInvoices(), await auditRefunds()];
  const line = (name, b) => {
    console.log(`\n=== ${name} ===`);
    for (const [k, v] of Object.entries(b)) if (k !== "manual") console.log(`  ${k.padEnd(18)}: ${v}`);
    console.log(`  manual IDs        : ${b.manual.length}${b.manual.length ? " " + JSON.stringify(b.manual.slice(0, 30)) : ""}`);
  };
  console.log("=== finance:direct-submit-audit (read-only, no PII) ===");
  line("Expenses (draft)", exp);
  line("Invoices (draft)", inv);
  line("Refunds (draft)", ref);
  console.log(`\nready → auto-submit: expenses ${exp.ready}, invoices ${inv.ready}, refunds ${ref.ready}`);
  console.log(`manual review      : expenses ${exp.manual.length}, invoices ${inv.manual.length}, refunds ${ref.manual.length}`);
  await p.$disconnect();
}
main();
