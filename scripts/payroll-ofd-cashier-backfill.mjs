// STAGE 13 backfill: build OfdCashierIdentity rows (+ auto/ambiguous/unmatched suggestions)
// from historical receipts that carry a cashier (spec §27). DRY-RUN by default; --apply writes.
// Idempotent (identityKey @unique). Never confirms ambiguous, never confirms without an exact
// unique employee match, never touches payroll or closed periods. Mirrors syncCashierIdentities.
//   node scripts/payroll-ofd-cashier-backfill.mjs            (dry-run)
//   node scripts/payroll-ofd-cashier-backfill.mjs --apply    (write)
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const normalize = (raw) => {
  if (!raw) return "";
  let s = String(raw).normalize("NFC").trim().toLowerCase().replace(/ё/g, "е");
  s = s.replace(/[.,;:"'`()\[\]{}]/g, " ").replace(/[-–—]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.split(" ").filter(Boolean).sort().join(" ") : "";
};
const identityKey = (r, norm) => [r.companyId, r.provider, r.connectionId, r.fnNumber, norm].join("|");
const withinEmployment = (e, at) => {
  const t = at.getTime();
  if (e.hireDate && t < new Date(e.hireDate).getTime()) return false;
  if (e.dismissedAt && t > new Date(e.dismissedAt).getTime()) return false;
  return true;
};

async function main() {
  const receipts = await p.ofdReceiptImport.findMany({ where: { operatorNormalized: { not: null } }, select: { companyId: true, provider: true, connectionId: true, clubId: true, legalEntityId: true, fnNumber: true, operatorName: true, operatorNormalized: true, receiptDate: true, operationType: true, totalKopeks: true } });
  const groups = new Map();
  for (const r of receipts) {
    const norm = r.operatorNormalized;
    const key = identityKey(r, norm);
    const g = groups.get(key) ?? { key, r0: r, norm, first: r.receiptDate, last: r.receiptDate, count: 0, sum: 0, clubId: r.clubId, legalEntityId: r.legalEntityId, rawName: r.operatorName };
    g.count += 1;
    if (r.operationType === "income") g.sum += r.totalKopeks;
    if (r.receiptDate < g.first) g.first = r.receiptDate;
    if (r.receiptDate > g.last) g.last = r.receiptDate;
    groups.set(key, g);
  }

  let toCreate = 0, autoMatch = 0, ambiguous = 0, unmatched = 0, existing = 0;
  for (const g of groups.values()) {
    const already = await p.ofdCashierIdentity.findUnique({ where: { identityKey: g.key } });
    if (already) { existing += 1; continue; }
    toCreate += 1;
    const emps = g.clubId ? await p.clubEmployee.findMany({ where: { companyId: g.r0.companyId, clubId: g.clubId, status: "active" }, select: { id: true, fullName: true, hireDate: true, dismissedAt: true } }) : [];
    const exact = emps.filter((e) => normalize(e.fullName) === g.norm && withinEmployment(e, g.last));
    if (exact.length === 1) autoMatch += 1; else if (exact.length > 1) ambiguous += 1; else unmatched += 1;

    if (APPLY) {
      const identity = await p.ofdCashierIdentity.create({ data: { companyId: g.r0.companyId, provider: g.r0.provider, ofdConnectionId: g.r0.connectionId, clubId: g.clubId, legalEntityId: g.legalEntityId, rawName: g.rawName ?? g.norm, normalizedName: g.norm, firstSeenAt: g.first, lastSeenAt: g.last, receiptsCount: g.count, salesAmountKopeks: g.sum, status: "active", identityKey: g.key } });
      const base = { companyId: g.r0.companyId, provider: g.r0.provider, ofdConnectionId: g.r0.connectionId, cashierIdentityId: identity.id, clubId: g.clubId ?? "", legalEntityId: g.legalEntityId, matchMethod: "exact_normalized_name", effectiveFrom: g.first };
      if (exact.length === 1) await p.ofdCashierMapping.create({ data: { ...base, employeeId: exact[0].id, status: "auto_matched", confidence: 100 } });
      else if (exact.length > 1) await p.ofdCashierMapping.create({ data: { ...base, employeeId: null, status: "ambiguous", comment: `Кандидаты: ${exact.map((e) => e.id).join(", ")}` } });
      else await p.ofdCashierMapping.create({ data: { ...base, employeeId: null, status: "unmatched" } });
    }
  }

  console.log(`=== payroll:ofd-cashier-backfill ${APPLY ? "(APPLY)" : "(DRY-RUN)"} ===`);
  console.log(`receipts with cashier : ${receipts.length}`);
  console.log(`identity groups       : ${groups.size}`);
  console.log(`already existing      : ${existing}`);
  console.log(`to create             : ${toCreate}`);
  console.log(`  auto_matched        : ${autoMatch}  (suggestion only, NOT confirmed)`);
  console.log(`  ambiguous           : ${ambiguous}  (manual review)`);
  console.log(`  unmatched           : ${unmatched}  (manual review)`);
  if (!APPLY) console.log("Dry-run only. Re-run with --apply to write. Payroll is never changed here.");
  await p.$disconnect();
}
main();
