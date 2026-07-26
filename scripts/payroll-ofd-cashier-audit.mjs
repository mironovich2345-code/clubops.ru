// STAGE 13 read-only audit of OFD cashier data for payroll attribution. Reports COUNTS and
// hashed technical IDs only — NO full cashier names, no personal data, no credentials, no
// connection strings (spec §26). Flags what needs manual review before backfill.
//   node scripts/payroll-ofd-cashier-audit.mjs
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
// Non-crypto djb2 hash so the report never prints a real name.
const h = (s) => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0; return x.toString(16); };

async function main() {
  const receipts = await p.ofdReceiptImport.findMany({ select: { companyId: true, provider: true, connectionId: true, fnNumber: true, fiscalDocumentNumber: true, fiscalSign: true, operationType: true, operatorNormalized: true } });
  const withCashier = receipts.filter((r) => r.operatorNormalized);
  const withoutCashier = receipts.length - withCashier.length;

  // Distinct identities (company|provider|connection|fn|normalizedName) + unique normalized names.
  const identityKeys = new Set();
  const uniqueNames = new Set();
  for (const r of withCashier) {
    identityKeys.add([r.companyId, r.provider, r.connectionId, r.fnNumber, r.operatorNormalized].join("|"));
    uniqueNames.add(h(r.operatorNormalized));
  }

  // Cross-provider duplicate risk: same fiscal fingerprint (fn:fd:sign:type) under >1 provider.
  const fpProviders = new Map();
  for (const r of receipts) {
    const fp = [r.fnNumber, r.fiscalDocumentNumber, r.fiscalSign ?? "", r.operationType].join(":");
    const set = fpProviders.get(fp) ?? new Set();
    set.add(r.provider);
    fpProviders.set(fp, set);
  }
  const providerDuplicates = [...fpProviders.values()].filter((s) => s.size > 1).length;

  const identities = await p.ofdCashierIdentity.count();
  const mappings = await p.ofdCashierMapping.groupBy({ by: ["status"], _count: { _all: true } });
  const byStatus = Object.fromEntries(mappings.map((m) => [m.status, m._count._all]));
  const refunds = receipts.filter((r) => r.operationType === "income_return").length;
  const refundsLinked = await p.payrollSalesAttribution.count({ where: { attributionType: "refund", originalSaleReceiptId: { not: null } } });

  console.log("=== payroll:ofd-cashier-audit (read-only, no PII) ===");
  console.log(`receipts total            : ${receipts.length}`);
  console.log(`receipts WITH cashier     : ${withCashier.length}`);
  console.log(`receipts WITHOUT cashier  : ${withoutCashier}  <- cannot attribute`);
  console.log(`distinct identity keys    : ${identityKeys.size}`);
  console.log(`unique normalized names   : ${uniqueNames.size} (hashed)`);
  console.log(`materialized identities   : ${identities}`);
  console.log(`mappings by status        : ${JSON.stringify(byStatus)}`);
  console.log(`  unmatched               : ${byStatus.unmatched ?? 0}  <- manual review`);
  console.log(`  ambiguous               : ${byStatus.ambiguous ?? 0}  <- manual review`);
  console.log(`refund receipts           : ${refunds}`);
  console.log(`refunds linked to a sale  : ${refundsLinked}  (rest need manual link)`);
  console.log(`cross-provider duplicates : ${providerDuplicates}  <- one physical receipt once`);
  await p.$disconnect();
  process.exit(0);
}
main();
