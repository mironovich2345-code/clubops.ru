// One-time idempotent backfill (Part 7): set Invoice.expensePeriod for rows that
// don't have it yet. expensePeriod = month(invoiceDate) ?? month(paidAt) ??
// month(createdAt). DB-agnostic (runs through Prisma).
// Run: node --env-file=.env scripts/backfill-invoice-expense-period.mjs
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

async function main() {
  const rows = await p.invoice.findMany({
    where: { expensePeriod: null },
    select: { id: true, invoiceDate: true, paidAt: true, createdAt: true },
  });
  let updated = 0;
  for (const r of rows) {
    const base = r.invoiceDate ?? r.paidAt ?? r.createdAt;
    await p.invoice.update({ where: { id: r.id }, data: { expensePeriod: monthKey(base) } });
    updated++;
  }
  console.log(`Backfilled expensePeriod for ${updated} invoice(s).`);
  await p.$disconnect();
}
main().catch(async (e) => { console.error(e); await p.$disconnect(); process.exit(1); });
