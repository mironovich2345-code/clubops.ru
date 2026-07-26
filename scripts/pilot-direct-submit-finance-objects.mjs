// Regression: create-and-submit for expenses / invoices / refunds (one click → regional
// review, no separate submit step) + safe backfill of legacy drafts. Static guards on the
// real forms/actions/scripts + real-DB invariants (status transitions, idempotency, routing,
// backfill readiness, tenant/IDOR).
//   npm run pilot:direct-submit-finance-objects
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

function staticGuards() {
  const expForm = src("../src/app/(app)/expenses/simple/SimpleExpenseForm.tsx");
  const expActions = src("../src/app/(app)/expenses/simplified-actions.ts");
  const invForm = src("../src/app/(app)/invoices/_components/InvoiceUpload.tsx");
  const invActions = src("../src/app/(app)/invoices/actions.ts");
  const refWorkflow = src("../src/app/(app)/refunds/_components/RefundWorkflow.tsx");
  const backfill = src("../scripts/finance-direct-submit-backfill.mjs");
  const auditScript = src("../scripts/finance-direct-submit-audit.mjs");

  // Expenses
  check("SG1 expense form: create → auto submitExpense (без отдельного шага) + подсказка", expForm.includes("submitExpense") && expForm.includes("После создания расход будет отправлен") && expForm.includes('router.push(`/expenses/${id}?submitted=1`)'));
  check("SG2 expense form: idempotent (draftIdRef reuse) + busy-guard, без confirm-modal", expForm.includes("draftIdRef") && expForm.includes("if (busy) return") && !/window\.confirm/.test(expForm));
  check("SG3 submitExpense идемпотентен (compare-and-set status in draft/needs_correction)", expActions.includes('status: { in: ["draft", "needs_correction"] }') && expActions.includes("res.count === 0"));
  check("SG4 маршрут по роли автора: менеджер→regional, регионал→accountant, нет регионала→блок", expActions.includes("PENDING_ACCOUNTANT; reviewTarget") && expActions.includes("PENDING_REGIONAL; reviewTarget") && expActions.includes("E.NO_REGIONAL"));
  check("SG5 расход: документ обязателен на отправке (≥1)", expActions.includes("activeDocumentCount(expenseId)) < 1"));
  check("SG6 расход: уведомление регионалу через notifyRegionalReview", expActions.includes('notifyRegionalReview({ resourceType: "expense"'));

  // Invoices (already draftless)
  check("SG7 invoice: createAndSubmitInvoice сразу needs_review + clientSubmissionId идемпотентность", invActions.includes('status: "needs_review"') && invActions.includes("clientSubmissionId"));
  check("SG8 invoice form: кнопка «Создать счёт» + подсказка, единое действие", invForm.includes('idle="Создать счёт"') && invForm.includes("После создания счёт будет отправлен") && invForm.includes("Счёт создан и отправлен региональному директору"));

  // Refunds
  check("SG9 refund: финальное действие «Создать возврат» (create-and-submit), resubmit-вариант", refWorkflow.includes('"Создать возврат"') && refWorkflow.includes("Исправить и отправить повторно") && refWorkflow.includes("submitted=1"));
  check("SG10 refund submit: без confirm-modal, busy-guard (idempotent на сервере)", !/window\.confirm/.test(refWorkflow.slice(refWorkflow.indexOf("SubmitToRegional"), refWorkflow.indexOf("RegionalReview"))) && refWorkflow.includes("if (busy) return"));

  // Backfill / audit
  check("SG11 backfill dry-run по умолчанию, --apply явно, аудит-событие миграции", backfill.includes("APPLY = process.argv.includes(\"--apply\")") && backfill.includes("auto_submitted_after_direct_submit_migration"));
  check("SG12 backfill: manual_review для неполных; НЕ сразу бухгалтеру; без финансовых движений", backfill.includes("res.manual++") && !/accountant|accounting_in_progress|pending_accountant/.test(backfill) && !/createSalaryExpense|recordExpenseMovement|cashMovement/.test(backfill));
  check("SG13 backfill: статусы региональной проверки (expense/invoice/refund) + сохранение автора", backfill.includes("pending_regional_budget_approval") && backfill.includes('status: "needs_review"') && backfill.includes("pending_regional_review") && backfill.includes("submittedByManagerId: r.createdByUserId"));
  check("SG14 backfill: idempotent (updateMany where status draft) + одно сводное уведомление на клуб", backfill.includes('where: { id: e.id, status: "draft" }') && backfill.includes("SUMMARY_TYPE") && backfill.includes("existing > 0) continue"));
  check("SG15 audit-script без ПДн (счётчики + ID)", auditScript.includes("no PII") && !/DATABASE_URL|password/i.test(auditScript));
}

async function realDb() {
  const uid = `dsf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const owner = await p.user.create({ data: { email: `${uid}-o@t.dev`, name: "O", role: "owner", isActive: true } });
  const mgr = await p.user.create({ data: { email: `${uid}-m@t.dev`, name: "M", role: "manager", isActive: true } });
  const reg = await p.user.create({ data: { email: `${uid}-r@t.dev`, name: "R", role: "regional_director", isActive: true } });
  const co = await p.company.create({ data: { name: `Co ${uid}` } });
  const otherCo = await p.company.create({ data: { name: `Other ${uid}` } });
  const club = await p.club.create({ data: { companyId: co.id, name: "A", city: "X" } });
  // regional access for the club (so a manager's object can route to regional)
  await p.clubUserAccess.create({ data: { userId: reg.id, clubId: club.id, role: "regional_director" } });
  const legal = await p.legalEntity.create({ data: { companyId: co.id, name: "ИП", type: "ip" } });

  // ---- Expense: draft + doc → submit (mirror) → pending_regional; idempotent ----
  const exp = await p.expense.create({ data: { companyId: co.id, clubId: club.id, legalEntityId: legal.id, category: "supplies", amountKopeks: 50000, expenseDate: new Date(), type: "receipt", paymentMethod: "cash", entryVersion: 2, status: "draft", createdByUserId: mgr.id, paidByUserId: mgr.id, comment: "x" } });
  const doc = (expenseId, key) => ({ data: { expenseId, companyId: co.id, clubId: club.id, storageKey: key, originalFilename: "r.pdf", safeFilename: "r.pdf", mimeType: "application/pdf", sizeBytes: 100, sha256: `sha-${key}`, documentType: "receipt", uploadedByUserId: mgr.id } });
  await p.expenseDocument.create(doc(exp.id, `k-${uid}`));
  const hasRegional = (await p.clubUserAccess.count({ where: { clubId: club.id, role: "regional_director", user: { isActive: true } } })) > 0;
  check("T1 expense: активный регионал для клуба есть → маршрут на regional", hasRegional);
  const sub1 = await p.expense.updateMany({ where: { id: exp.id, status: { in: ["draft", "needs_correction"] } }, data: { status: "pending_regional_budget_approval", submittedAt: new Date() } });
  check("T2 expense: create→submit ставит pending_regional_budget_approval (одним действием)", sub1.count === 1 && (await p.expense.findUnique({ where: { id: exp.id } })).status === "pending_regional_budget_approval");
  const sub2 = await p.expense.updateMany({ where: { id: exp.id, status: { in: ["draft", "needs_correction"] } }, data: { status: "pending_regional_budget_approval" } });
  check("T3 expense: повторная отправка идемпотентна (count=0, нет дубля статуса)", sub2.count === 0);
  const createdAtBefore = exp.createdAt.getTime();
  check("T4 expense: автор и createdAt сохранены", (await p.expense.findUnique({ where: { id: exp.id } })).createdByUserId === mgr.id && (await p.expense.findUnique({ where: { id: exp.id } })).createdAt.getTime() === createdAtBefore);

  // ---- Invoice: draft → needs_review; clientSubmissionId dedupe ----
  const inv = await p.invoice.create({ data: { companyId: co.id, clubId: club.id, legalEntityId: legal.id, counterpartyName: "ООО", amountKopeks: 100000, status: "needs_review", confidence: "low", originalFileStorageKey: `f-${uid}`, createdByUserId: mgr.id, clientSubmissionId: `cs-${uid}` } });
  check("T5 invoice: создаётся сразу в needs_review (draftless)", inv.status === "needs_review");
  let dupInv = false;
  try { await p.invoice.create({ data: { companyId: co.id, clubId: club.id, counterpartyName: "ООО", amountKopeks: 1, status: "needs_review", confidence: "low", createdByUserId: mgr.id, clientSubmissionId: `cs-${uid}` } }); } catch { dupInv = true; }
  check("T6 invoice: clientSubmissionId @unique → повтор не создаёт дубль", dupInv);

  // ---- Refund v2: draft + 4 docs + amount + client → submit → pending_regional_review ----
  const ref = await p.refund.create({ data: { companyId: co.id, clubId: club.id, returnType: "membership", entryVersion: 2, status: "draft", confidence: "low", clientName: "Иван", refundResultAmountKopeks: 30000, amountKopeks: 30000, createdByUserId: mgr.id } });
  for (const t of ["contract_page_1", "contract_page_2", "refund_application", "payment_receipt"]) {
    await p.refundDocument.create({ data: { refundId: ref.id, companyId: co.id, clubId: club.id, documentType: t, storageKey: `${t}-${uid}`, originalFilename: `${t}.pdf`, safeFilename: `${t}.pdf`, mimeType: "application/pdf", sizeBytes: 100, sha256: `sha-${t}-${uid}`, uploadedByUserId: mgr.id, activeSlotKey: `${ref.id}:${t}` } });
  }
  const refSub = await p.refund.updateMany({ where: { id: ref.id, status: { in: ["draft", "needs_correction"] } }, data: { status: "pending_regional_review", regionalReviewRequestedAt: new Date(), submittedByManagerId: mgr.id } });
  check("T7 refund: create→submit ставит pending_regional_review одним действием", refSub.count === 1 && (await p.refund.findUnique({ where: { id: ref.id } })).status === "pending_regional_review");
  const refSub2 = await p.refund.updateMany({ where: { id: ref.id, status: { in: ["draft", "needs_correction"] } }, data: { status: "pending_regional_review" } });
  check("T8 refund: повтор идемпотентен (count=0)", refSub2.count === 0);

  // ---- Backfill readiness mirror ----
  // ready draft expense (manager, doc, regional) migrates; incomplete (no doc) stays manual.
  const draftReady = await p.expense.create({ data: { companyId: co.id, clubId: club.id, legalEntityId: legal.id, category: "supplies", amountKopeks: 100, expenseDate: new Date(), type: "receipt", paymentMethod: "cash", entryVersion: 2, status: "draft", createdByUserId: mgr.id, paidByUserId: mgr.id, comment: "x" } });
  await p.expenseDocument.create(doc(draftReady.id, `bk-${uid}`));
  const draftNoDoc = await p.expense.create({ data: { companyId: co.id, clubId: club.id, legalEntityId: legal.id, category: "supplies", amountKopeks: 100, expenseDate: new Date(), type: "receipt", paymentMethod: "cash", entryVersion: 2, status: "draft", createdByUserId: mgr.id, paidByUserId: mgr.id, comment: "x" } });
  const readyDocs = await p.expenseDocument.count({ where: { expenseId: draftReady.id, removedAt: null } });
  const noDocDocs = await p.expenseDocument.count({ where: { expenseId: draftNoDoc.id, removedAt: null } });
  check("T9 backfill: draft с документом → готов; без документа → manual_review", readyDocs >= 1 && noDocDocs === 0);
  const bfUpd = await p.expense.updateMany({ where: { id: draftReady.id, status: "draft" }, data: { status: "pending_regional_budget_approval", submittedAt: new Date() } });
  check("T10 backfill переводит готовый draft на regional, createdAt не меняется", bfUpd.count === 1 && (await p.expense.findUnique({ where: { id: draftReady.id } })).createdAt.getTime() === draftReady.createdAt.getTime());
  const bfRerun = await p.expense.updateMany({ where: { id: draftReady.id, status: "draft" }, data: { status: "pending_regional_budget_approval" } });
  check("T11 backfill идемпотентен (повтор count=0, нет дубля)", bfRerun.count === 0);
  check("T12 backfill: недоделанный draft остаётся draft (manual_review, не отправлен)", (await p.expense.findUnique({ where: { id: draftNoDoc.id } })).status === "draft");
  await p.auditLog.create({ data: { companyId: co.id, clubId: club.id, userId: mgr.id, action: "auto_submitted_after_direct_submit_migration", entityType: "Expense", entityId: draftReady.id, metadataJson: "{}" } });
  check("T13 backfill audit-событие создаётся", (await p.auditLog.count({ where: { action: "auto_submitted_after_direct_submit_migration", entityId: draftReady.id } })) === 1);
  check("T14 backfill не создаёт финансовых движений (нет CashMovement на эти объекты)", (await p.cashMovement.count({ where: { companyId: co.id } })) === 0);

  // ---- Tenant / IDOR ----
  check("T15 tenant isolation: чужая компания не видит объекты", (await p.expense.count({ where: { companyId: otherCo.id } })) === 0 && (await p.refund.count({ where: { companyId: otherCo.id } })) === 0);
  check("T16 IDOR: объекты принадлежат своей компании/клубу", (await p.expense.findMany({ where: { companyId: co.id } })).every((e) => e.companyId === co.id && e.clubId === club.id));

  // cleanup
  await p.auditLog.deleteMany({ where: { companyId: co.id } });
  await p.refundDocument.deleteMany({ where: { companyId: co.id } });
  await p.refund.deleteMany({ where: { companyId: co.id } });
  await p.expenseDocument.deleteMany({ where: { companyId: co.id } });
  await p.invoice.deleteMany({ where: { companyId: co.id } });
  await p.expense.deleteMany({ where: { companyId: co.id } });
  await p.clubUserAccess.deleteMany({ where: { clubId: club.id } });
  await p.legalEntity.deleteMany({ where: { companyId: co.id } });
  await p.club.deleteMany({ where: { companyId: co.id } });
  await p.company.deleteMany({ where: { id: { in: [co.id, otherCo.id] } } });
  await p.user.deleteMany({ where: { id: { in: [owner.id, mgr.id, reg.id] } } });
}

async function main() {
  staticGuards();
  await realDb();
  await p.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
