// STAGE 13 read-only audit of payroll sales attributions (spec §26). Counts + technical IDs
// only — no personal data. Verifies idempotency invariants and surfaces disputed refunds.
//   node scripts/payroll-ofd-attribution-audit.mjs
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const byType = await p.payrollSalesAttribution.groupBy({ by: ["attributionType"], _count: { _all: true }, _sum: { amountKopeks: true } });
  const byStatus = await p.payrollSalesAttribution.groupBy({ by: ["status"], _count: { _all: true } });
  const all = await p.payrollSalesAttribution.findMany({ select: { dedupeKey: true, ofdReceiptId: true, attributionType: true } });
  const keys = new Set();
  let dupKeys = 0;
  for (const a of all) { if (keys.has(a.dedupeKey)) dupKeys += 1; keys.add(a.dedupeKey); }
  const refundsUnlinked = await p.payrollSalesAttribution.count({ where: { attributionType: "refund", originalSaleReceiptId: null } });

  console.log("=== payroll:ofd-attribution-audit (read-only) ===");
  console.log(`attributions total : ${all.length}`);
  console.log(`by type            : ${JSON.stringify(Object.fromEntries(byType.map((t) => [t.attributionType, { n: t._count._all, sum: t._sum.amountKopeks ?? 0 }])))}`);
  console.log(`by status          : ${JSON.stringify(Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])))}`);
  console.log(`duplicate dedupeKey : ${dupKeys}  (must be 0 — @unique enforces idempotency)`);
  console.log(`refunds w/o original: ${refundsUnlinked}  <- manual review`);
  await p.$disconnect();
  process.exit(dupKeys > 0 ? 2 : 0);
}
main();
