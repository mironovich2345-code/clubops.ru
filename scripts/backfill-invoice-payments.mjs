// One-time backfill: create ONE legacy InvoicePayment (full amount) per existing PAID invoice
// that has no payment rows yet, so paidTotal = total and the status stays `paid`. Idempotent
// (idempotencyKey = "legacy:<invoiceId>"), non-destructive, integer kopeks. Analytics/budgets
// keep reflecting the invoice by expensePeriod (accrual) and do NOT read InvoicePayment, so
// there is NO double count. Also runs a read-only preflight.
//
//   node scripts/backfill-invoice-payments.mjs            # dry-run + preflight (default)
//   node scripts/backfill-invoice-payments.mjs --apply    # create the legacy payments
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const fmt = (k) => `${(k / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Режим: ${apply ? "APPLY (создание платежей)" : "DRY-RUN (ничего не меняется)"}\n`);

  const paidInvoices = await prisma.invoice.findMany({
    where: { status: "paid" },
    select: { id: true, companyId: true, clubId: true, amountKopeks: true, paidAt: true, createdAt: true, createdByUserId: true },
  });
  const withPayments = new Set((await prisma.invoicePayment.groupBy({ by: ["invoiceId"], _count: { _all: true } })).map((g) => g.invoiceId));

  // ---- Preflight (read-only) ----
  const badAmount = paidInvoices.filter((i) => i.amountKopeks <= 0);
  const noPaidAt = paidInvoices.filter((i) => !i.paidAt);
  const alreadyModelled = paidInvoices.filter((i) => withPayments.has(i.id));
  console.log(`Preflight:`);
  console.log(`  paid счетов всего: ${paidInvoices.length}`);
  console.log(`  [!] paid с суммой ≤ 0: ${badAmount.length}`);
  console.log(`  [i] paid без paidAt (возьмём createdAt): ${noPaidAt.length}`);
  console.log(`  [i] уже есть платежи (пропустим): ${alreadyModelled.length}`);

  const toBackfill = paidInvoices.filter((i) => i.amountKopeks > 0 && !withPayments.has(i.id));
  console.log(`\nК бэкофиллу: ${toBackfill.length} счёт(ов) на сумму ${fmt(toBackfill.reduce((a, i) => a + i.amountKopeks, 0))}\n`);

  let created = 0, skipped = 0;
  for (const inv of toBackfill) {
    const key = `legacy:${inv.id}`;
    const exists = await prisma.invoicePayment.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
    if (exists) { skipped++; continue; } // idempotent
    if (apply) {
      await prisma.invoicePayment.create({
        data: {
          companyId: inv.companyId, invoiceId: inv.id, amountKopeks: inv.amountKopeks,
          paymentDate: inv.paidAt ?? inv.createdAt, source: "legacy_backfill",
          createdById: inv.createdByUserId, status: "confirmed", legacyBackfill: true, idempotencyKey: key,
        },
      });
      created++;
    } else {
      console.log(`  [dry] ${inv.id} · ${fmt(inv.amountKopeks)} · ${(inv.paidAt ?? inv.createdAt).toISOString().slice(0, 10)}`);
    }
  }

  console.log(`\n${apply ? `Создано платежей: ${created}, пропущено (idempotent): ${skipped}.` : `Будет создано: ${toBackfill.length} (запустите с --apply).`}`);
  console.log(`Откат: платежи append-only; при необходимости отменяйте их через сторно (главбух), НЕ удаляйте — финансовая история сохраняется.`);
  console.log(`\nUnpaid счета не затрагиваются. Данные ${apply ? "изменены только созданием legacy-платежей" : "НЕ изменялись"}.`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
