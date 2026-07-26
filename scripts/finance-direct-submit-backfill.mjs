// Backfill: move ready legacy DRAFT expenses/invoices/refunds to regional review
// (spec §8/§9/§10). DRY-RUN by default; --apply writes. Idempotent (status precondition),
// preserves author + createdAt, adds an audit event, and enqueues ONE summary notification
// per club. Broken drafts are left as manual_review (never guessed, never deleted). No
// financial movements are created.
//   node scripts/finance-direct-submit-backfill.mjs            (dry-run)
//   node scripts/finance-direct-submit-backfill.mjs --apply    (write)
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const AUDIT_ACTION = "auto_submitted_after_direct_submit_migration";
const SUMMARY_TYPE = "finance.direct_submit_migration_summary";

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
async function regionalRecipients(companyId, clubId) {
  const [club, company] = await Promise.all([
    p.clubUserAccess.findMany({ where: { clubId, role: "regional_director", user: { isActive: true } }, select: { userId: true } }),
    p.companyUserAccess.findMany({ where: { companyId, role: "regional_director", user: { isActive: true } }, select: { userId: true } }),
  ]);
  return [...new Set([...club.map((r) => r.userId), ...company.map((r) => r.userId)])];
}

async function auditEvent(companyId, clubId, userId, entityType, entityId) {
  if (!APPLY) return;
  await p.auditLog.create({ data: { companyId, clubId, userId, action: AUDIT_ACTION, entityType, entityId, metadataJson: JSON.stringify({ migratedAt: new Date().toISOString() }) } });
}

async function migrate() {
  const perClub = new Map(); // clubKey -> { companyId, clubId, expenses, invoices, refunds }
  const bump = (companyId, clubId, kind) => {
    const k = `${companyId}|${clubId}`;
    const g = perClub.get(k) ?? { companyId, clubId, expenses: 0, invoices: 0, refunds: 0 };
    g[kind] += 1; perClub.set(k, g);
  };
  const res = { expenses: 0, invoices: 0, refunds: 0, manual: 0 };

  // ---- Expenses (draft, v2) → pending_regional_budget_approval (manager-created only) ----
  for (const e of await p.expense.findMany({ where: { entryVersion: 2, status: "draft" }, select: { id: true, companyId: true, clubId: true, createdByUserId: true } })) {
    const docs = await p.expenseDocument.count({ where: { expenseId: e.id, removedAt: null } });
    const ready = e.companyId && e.clubId && docs >= 1 && !(await creatorIsRegional(e.createdByUserId, e.clubId)) && (await hasRegional(e.companyId, e.clubId));
    if (!ready) { res.manual++; continue; }
    if (APPLY) {
      const upd = await p.expense.updateMany({ where: { id: e.id, status: "draft" }, data: { status: "pending_regional_budget_approval", submittedAt: new Date() } });
      if (upd.count === 1) { await auditEvent(e.companyId, e.clubId, e.createdByUserId, "Expense", e.id); res.expenses++; bump(e.companyId, e.clubId, "expenses"); }
    } else { res.expenses++; bump(e.companyId, e.clubId, "expenses"); }
  }

  // ---- Invoices (draft) → needs_review ----
  for (const inv of await p.invoice.findMany({ where: { status: "draft" }, select: { id: true, companyId: true, clubId: true, originalFileStorageKey: true, counterpartyName: true, amountKopeks: true, createdByUserId: true } })) {
    const ready = inv.companyId && inv.clubId && inv.originalFileStorageKey && inv.counterpartyName && inv.amountKopeks > 0;
    if (!ready) { res.manual++; continue; }
    if (APPLY) {
      const upd = await p.invoice.updateMany({ where: { id: inv.id, status: "draft" }, data: { status: "needs_review" } });
      if (upd.count === 1) { await auditEvent(inv.companyId, inv.clubId, inv.createdByUserId, "Invoice", inv.id); res.invoices++; bump(inv.companyId, inv.clubId, "invoices"); }
    } else { res.invoices++; bump(inv.companyId, inv.clubId, "invoices"); }
  }

  // ---- Refunds (draft, v2) → pending_regional_review ----
  for (const r of await p.refund.findMany({ where: { entryVersion: 2, status: "draft" }, select: { id: true, companyId: true, clubId: true, clientName: true, refundResultAmountKopeks: true, createdByUserId: true } })) {
    if (!r.companyId || !r.clubId || !r.clientName || !(r.refundResultAmountKopeks > 0)) { res.manual++; continue; }
    const active = await p.refundDocument.findMany({ where: { refundId: r.id, removedAt: null }, select: { documentType: true } });
    if (new Set(active.map((d) => d.documentType)).size < 4) { res.manual++; continue; }
    if (APPLY) {
      const upd = await p.refund.updateMany({ where: { id: r.id, status: "draft" }, data: { status: "pending_regional_review", regionalReviewRequestedAt: new Date(), submittedByManagerId: r.createdByUserId } });
      if (upd.count === 1) { await auditEvent(r.companyId, r.clubId, r.createdByUserId, "Refund", r.id); res.refunds++; bump(r.companyId, r.clubId, "refunds"); }
    } else { res.refunds++; bump(r.companyId, r.clubId, "refunds"); }
  }

  // ---- One summary notification per club (idempotent; controlled batch, §15) ----
  if (APPLY) {
    for (const g of perClub.values()) {
      const existing = await p.notificationOutbox.count({ where: { type: SUMMARY_TYPE, clubId: g.clubId } });
      if (existing > 0) continue; // don't duplicate on re-run
      for (const userId of await regionalRecipients(g.companyId, g.clubId)) {
        await p.notificationOutbox.create({ data: { type: SUMMARY_TYPE, recipientUserId: userId, resourceType: "expense", resourceId: g.clubId, companyId: g.companyId, clubId: g.clubId, payloadJson: JSON.stringify({ resourceType: "migration_summary", expenses: g.expenses, invoices: g.invoices, refunds: g.refunds }) } });
      }
    }
  }

  return res;
}

async function main() {
  console.log(`=== finance:direct-submit-backfill ${APPLY ? "(APPLY)" : "(DRY-RUN)"} ===`);
  const res = await migrate();
  console.log(`expenses → regional : ${res.expenses}`);
  console.log(`invoices → regional : ${res.invoices}`);
  console.log(`refunds  → regional : ${res.refunds}`);
  console.log(`manual review (left): ${res.manual}`);
  if (!APPLY) console.log("Dry-run only. Re-run with --apply to write. No financial movements are created.");
  await p.$disconnect();
}
main();
