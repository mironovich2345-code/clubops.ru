// REM-08 — REAL DB-backed tests. Imports & EXECUTES the actual ledger service
// (applyInvoicePaymentInTx / applyInvoicePaymentReversalInTx) via jiti against a
// disposable sqlite copy, plus calculateProfit to prove payments never move the
// recognized expense. Real rows, real $transaction — not string checks.
//   node scripts/rem-08-invoice-ledger-tests.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = join(ROOT, ".rem08-tmp");
mkdirSync(SCRATCH, { recursive: true });
const TMP_DB = join(SCRATCH, "rem08.db");
const SRC = join(ROOT, "src");
const DEV_DB = join(ROOT, "prisma", "dev.db");
if (!existsSync(DEV_DB)) { console.error("dev.db not found"); process.exit(1); }
for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
copyFileSync(DEV_DB, TMP_DB);
process.env.DATABASE_URL = "file:" + TMP_DB.replace(/\\/g, "/");

const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), { alias: { "@": SRC, "server-only": join(ROOT, "scripts", "_stubs", "server-only.cjs") }, interopDefault: true, esmResolve: true });
const { applyInvoicePaymentInTx, applyInvoicePaymentReversalInTx } = jiti("@/lib/invoices/payment-ledger.ts");
const { paidTotalKopeks, derivedInvoiceStatus, validatePaymentAmount } = jiti("@/lib/invoice-payments.ts");
const { calculateProfit } = jiti("@/lib/finance/profit.ts");
const { prisma } = jiti("@/lib/prisma.ts");

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 10);
const R = (rub) => Math.round(rub * 100);
const day = (s) => new Date(s + "T00:00:00");

async function seedInvoice(amount, status = "approved_by_regional") {
  const companyId = uid("co"), clubId = uid("cl"), userId = uid("u");
  await prisma.company.create({ data: { id: companyId, name: "Co" } });
  await prisma.user.create({ data: { id: userId, email: uid("e") + "@t.local", name: "T", role: "accountant", passwordHash: "x" } });
  await prisma.club.create({ data: { id: clubId, companyId, name: "C", city: "T" } });
  const inv = await prisma.invoice.create({ data: { companyId, clubId, createdByUserId: userId, amountKopeks: amount, expenseCategory: "supplies", expensePeriod: "2026-07", invoiceDate: day("2026-07-05"), status } });
  return { companyId, clubId, userId, inv };
}
const load = (id) => prisma.invoice.findUnique({ where: { id }, select: { id: true, companyId: true, amountKopeks: true, status: true, prePaymentStatus: true, paidAt: true } });
const pay = (invoice, amount, key, date = "2026-07-10", source = "bank") =>
  prisma.$transaction((tx) => applyInvoicePaymentInTx(tx, { invoice, amountKopeks: amount, paymentDate: day(date), source, createdById: invoice.companyId, idempotencyKey: key }));

async function main() {
  // 1/2. Full payment creates a confirmed InvoicePayment + status paid + paidAt set.
  { const s = await seedInvoice(R(100_000)); await pay(await load(s.inv.id), R(100_000), uid("k"));
    const inv = await load(s.inv.id); const pays = await prisma.invoicePayment.count({ where: { invoiceId: s.inv.id, status: "confirmed" } });
    check("1/2 full payment → ledger row + status paid + paidAt", pays === 1 && inv.status === "paid" && inv.paidAt !== null); }
  // 3. Partial payment → partially_paid, paidAt null.
  { const s = await seedInvoice(R(100_000)); await pay(await load(s.inv.id), R(40_000), uid("k"));
    const inv = await load(s.inv.id); check("3 partial payment → partially_paid, paidAt null", inv.status === "partially_paid" && inv.paidAt === null); }
  // 4. Second payment closes remaining → paid.
  { const s = await seedInvoice(R(100_000)); await pay(await load(s.inv.id), R(40_000), uid("k1")); await pay(await load(s.inv.id), R(60_000), uid("k2"));
    const inv = await load(s.inv.id); check("4 second payment closes → paid", inv.status === "paid" && inv.paidAt !== null); }
  // 5/6. Over-remaining + zero/negative blocked (validatePaymentAmount, the action guard).
  check("5 payment > remaining blocked", validatePaymentAmount(R(120_000), R(100_000), "partial") === "over_remaining");
  check("6 zero/negative blocked", validatePaymentAmount(0, R(100_000), "partial") === "not_positive" && validatePaymentAmount(-5, R(100_000), "partial") === "not_positive");
  // 7. Same idempotency key replay → one row (second create hits @unique).
  { const s = await seedInvoice(R(100_000)); const k = uid("k"); await pay(await load(s.inv.id), R(50_000), k);
    let threw = false; try { await pay(await load(s.inv.id), R(50_000), k); } catch { threw = true; }
    const n = await prisma.invoicePayment.count({ where: { invoiceId: s.inv.id } });
    check("7 same idempotency key → one row (replay/duplicate blocked)", threw && n === 1, `n=${n}`); }
  // 8. paidTotal excludes reversed (ledger is source of truth).
  { const fresh = [{ status: "confirmed", amountKopeks: R(30_000) }, { status: "reversed", amountKopeks: R(20_000) }];
    check("8 paidTotal = confirmed only (reversed excluded)", paidTotalKopeks(fresh) === R(30_000)); }
  // 14/15. Reversal restores remaining + downgrades paid→partial.
  { const s = await seedInvoice(R(100_000)); await pay(await load(s.inv.id), R(60_000), uid("k1")); await pay(await load(s.inv.id), R(40_000), uid("k2"));
    const paidId = (await prisma.invoicePayment.findFirst({ where: { invoiceId: s.inv.id, amountKopeks: R(40_000) } })).id;
    const invR = await load(s.inv.id);
    await prisma.$transaction((tx) => applyInvoicePaymentReversalInTx(tx, { invoice: invR, paymentId: paidId, reversedById: s.userId, reason: "test reversal reason" }));
    const inv = await load(s.inv.id); const conf = await prisma.invoicePayment.count({ where: { invoiceId: s.inv.id, status: "confirmed" } });
    check("14/15 reversal restores remaining, paid→partially_paid (append-only)", inv.status === "partially_paid" && conf === 1 && inv.paidAt === null); }
  // 16. partial→unpaid after reversing the only payment (status restored to pre).
  { const s = await seedInvoice(R(100_000)); await pay(await load(s.inv.id), R(40_000), uid("k"));
    const pid = (await prisma.invoicePayment.findFirst({ where: { invoiceId: s.inv.id } })).id;
    const invR = await load(s.inv.id);
    await prisma.$transaction((tx) => applyInvoicePaymentReversalInTx(tx, { invoice: invR, paymentId: pid, reversedById: s.userId, reason: "reverse the only payment" }));
    const inv = await load(s.inv.id); check("16 reversing the only payment → back to approved (unpaid)", inv.status === "approved_by_regional"); }
  // 17. Double reversal → ok:false (no second effect); row stays reversed.
  { const s = await seedInvoice(R(100_000)); await pay(await load(s.inv.id), R(100_000), uid("k"));
    const pid = (await prisma.invoicePayment.findFirst({ where: { invoiceId: s.inv.id } })).id;
    const inv1 = await load(s.inv.id);
    await prisma.$transaction((tx) => applyInvoicePaymentReversalInTx(tx, { invoice: inv1, paymentId: pid, reversedById: s.userId, reason: "first reversal here" }));
    const inv2 = await load(s.inv.id);
    const r2 = await prisma.$transaction((tx) => applyInvoicePaymentReversalInTx(tx, { invoice: inv2, paymentId: pid, reversedById: s.userId, reason: "second reversal attempt" }));
    check("17 double reversal blocked (ok:false)", r2.ok === false); }
  // 11/12. FAILURE INJECTION: throw after the payment create inside the tx → full rollback.
  { const s = await seedInvoice(R(100_000)); const invF = await load(s.inv.id);
    let threw = false;
    try { await prisma.$transaction(async (tx) => { await applyInvoicePaymentInTx(tx, { invoice: invF, amountKopeks: R(50_000), paymentDate: day("2026-07-10"), source: "bank", createdById: s.userId, idempotencyKey: uid("k") }); throw new Error("inject failure after create"); }); } catch { threw = true; }
    const n = await prisma.invoicePayment.count({ where: { invoiceId: s.inv.id } }); const inv = await load(s.inv.id);
    check("11/12 failure after create rolls back (no row, status unchanged)", threw && n === 0 && inv.status === "approved_by_regional"); }
  // 23. paidAt only on full paid (partial leaves it null) — covered in 3; assert full sets it.
  { const s = await seedInvoice(R(50_000)); await pay(await load(s.inv.id), R(50_000), uid("k"));
    check("23 paidAt set only when fully paid", (await load(s.inv.id)).paidAt !== null); }
  // 26/27. Payment does NOT change the recognized expense / profit (REM-05 invariant).
  { const s = await seedInvoice(R(200_000), "partially_paid");
    await prisma.ofdDailySalesSummary.create({ data: { companyId: s.companyId, clubId: s.clubId, provider: "taxcom", date: "2026-07-15", summaryKey: uid("k"), incomeTotalKopeks: R(500_000), netTotalKopeks: R(500_000), receiptCount: 1 } });
    const before = await calculateProfit({ companyId: s.companyId, allowedClubIds: [s.clubId], months: ["2026-07"] });
    await pay(await load(s.inv.id), R(120_000), uid("k"));
    const after = await calculateProfit({ companyId: s.companyId, allowedClubIds: [s.clubId], months: ["2026-07"] });
    check("26/27 payment does NOT change profit/recognized expense", before.profitKopeks === after.profitKopeks && after.expenseKopeks === R(200_000), `before ${before.profitKopeks} after ${after.profitKopeks}`); }
  // 30/31. Exact kopeks, no float drift over three partials.
  { const s = await seedInvoice(1000); await pay(await load(s.inv.id), 333, uid("a")); await pay(await load(s.inv.id), 333, uid("b")); await pay(await load(s.inv.id), 334, uid("c"));
    const inv = await load(s.inv.id); const paid = paidTotalKopeks(await prisma.invoicePayment.findMany({ where: { invoiceId: s.inv.id }, select: { status: true, amountKopeks: true } }));
    check("30/31 exact kopeks (333+333+334=1000 → paid)", paid === 1000 && inv.status === "paid"); }
  // derivedInvoiceStatus pure.
  check("derivedInvoiceStatus paid/partial/restore", derivedInvoiceStatus(1000, 1000, "approved_by_regional", "partially_paid") === "paid" && derivedInvoiceStatus(400, 1000, "approved_by_regional", "approved_by_regional") === "partially_paid" && derivedInvoiceStatus(0, 1000, "approved_by_regional", "partially_paid") === "approved_by_regional");

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) rmSync(f, { force: true });
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error("rem-08 tests crashed:", e); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
