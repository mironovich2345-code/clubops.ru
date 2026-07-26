// STAGE 13: OFD → employee personal-sales attribution for a payroll period. The SAME service
// powers preview and apply (spec §16). Idempotent per physical receipt (dedupeKey). A sale is
// attributed to the confirmed cashier of its shift; a REFUND reduces the ORIGINAL sale's
// employee (never the refund's cashier), and only when the original is known — otherwise it is
// unmatched_refund for manual review (spec §12). No money movement, no Expense.
import { prisma } from "@/lib/prisma";
import { buildIdentityKey, receiptFiscalFingerprint, attributionDedupeKey, coversDate, isAttributingStatus } from "@/lib/ofd/cashier-identity";

const monthRange = (year: number, month: number) => ({ start: new Date(year, month - 1, 1, 0, 0, 0, 0), end: new Date(year, month, 1, 0, 0, 0, 0) });

export type PeriodSalesPreview = {
  employees: Array<{ employeeId: string; saleKopeks: number; refundKopeks: number; netKopeks: number; receiptCount: number }>;
  totalNetKopeks: number;
  unmatchedReceiptCount: number;
  unmatchedAmountKopeks: number;
  disputedRefundCount: number;
  disputedRefundAmountKopeks: number;
  lastReceiptAt: Date | null;
};

type ReceiptRow = { id: string; provider: string; connectionId: string; fnNumber: string; fiscalDocumentNumber: number; fiscalSign: string | null; operationType: string; operatorNormalized: string | null; receiptDate: Date; totalKopeks: number };

/** Resolve the attributing employee for a SALE receipt (confirmed/manual mapping covering the
 * receipt date), or null if none / not attributing. */
async function resolveSaleEmployee(companyId: string, r: ReceiptRow): Promise<string | null> {
  if (!r.operatorNormalized) return null;
  const identityKey = buildIdentityKey({ companyId, provider: r.provider, ofdConnectionId: r.connectionId, fnNumber: r.fnNumber, normalizedName: r.operatorNormalized });
  const identity = await prisma.ofdCashierIdentity.findUnique({ where: { identityKey }, select: { id: true } });
  if (!identity) return null;
  const mappings = await prisma.ofdCashierMapping.findMany({ where: { cashierIdentityId: identity.id, employeeId: { not: null } }, select: { employeeId: true, status: true, effectiveFrom: true, effectiveTo: true } });
  const covering = mappings.filter((m) => isAttributingStatus(m.status) && coversDate(m, r.receiptDate));
  // Ambiguous overlap → don't attribute (safety); exactly one attributing mapping wins.
  if (covering.length !== 1) return null;
  return covering[0].employeeId;
}

/** Find the employee of the ORIGINAL sale behind a refund (spec §12). Only via a known link:
 * an existing attribution whose receipt shares the refund's fiscal fingerprint sans-return, or
 * an explicit originalSaleReceiptId. Never falls back to the refund's own cashier. */
async function resolveRefundOriginalEmployee(companyId: string, refund: ReceiptRow): Promise<{ employeeId: string; originalReceiptId: string } | null> {
  // A prior manual/auto link stored on a PayrollSalesAttribution for this refund receipt.
  const existing = await prisma.payrollSalesAttribution.findFirst({ where: { companyId, ofdReceiptId: refund.id, attributionType: "refund", originalSaleReceiptId: { not: null } }, select: { employeeId: true, originalSaleReceiptId: true } });
  if (existing?.originalSaleReceiptId) return { employeeId: existing.employeeId, originalReceiptId: existing.originalSaleReceiptId };
  return null; // no reliable original → caller marks unmatched_refund
}

/**
 * Preview period sales attribution (spec §15/§16) WITHOUT writing. Aggregates confirmed sales
 * per employee, counts unmatched receipts and disputed refunds. Read-only.
 */
export async function previewPeriodSales(companyId: string, clubId: string, year: number, month: number): Promise<PeriodSalesPreview> {
  const { start, end } = monthRange(year, month);
  const receipts = await prisma.ofdReceiptImport.findMany({
    where: { companyId, clubId, receiptDate: { gte: start, lt: end }, operationType: { in: ["income", "income_return"] } },
    select: { id: true, provider: true, connectionId: true, fnNumber: true, fiscalDocumentNumber: true, fiscalSign: true, operationType: true, operatorNormalized: true, receiptDate: true, totalKopeks: true },
    orderBy: { receiptDate: "asc" },
  });
  const byEmp = new Map<string, { saleKopeks: number; refundKopeks: number; receiptCount: number }>();
  let unmatchedReceiptCount = 0, unmatchedAmountKopeks = 0, disputedRefundCount = 0, disputedRefundAmountKopeks = 0;
  let lastReceiptAt: Date | null = null;
  const bump = (id: string, sale: number, refund: number) => { const e = byEmp.get(id) ?? { saleKopeks: 0, refundKopeks: 0, receiptCount: 0 }; e.saleKopeks += sale; e.refundKopeks += refund; e.receiptCount += 1; byEmp.set(id, e); };

  for (const r of receipts) {
    lastReceiptAt = r.receiptDate;
    if (r.operationType === "income") {
      const emp = await resolveSaleEmployee(companyId, r);
      if (emp) bump(emp, r.totalKopeks, 0);
      else { unmatchedReceiptCount += 1; unmatchedAmountKopeks += r.totalKopeks; }
    } else {
      const orig = await resolveRefundOriginalEmployee(companyId, r);
      if (orig) bump(orig.employeeId, 0, r.totalKopeks);
      else { disputedRefundCount += 1; disputedRefundAmountKopeks += r.totalKopeks; }
    }
  }
  const employees = [...byEmp.entries()].map(([employeeId, v]) => ({ employeeId, saleKopeks: v.saleKopeks, refundKopeks: v.refundKopeks, netKopeks: v.saleKopeks - v.refundKopeks, receiptCount: v.receiptCount }));
  return {
    employees,
    totalNetKopeks: employees.reduce((s, e) => s + e.netKopeks, 0),
    unmatchedReceiptCount, unmatchedAmountKopeks, disputedRefundCount, disputedRefundAmountKopeks, lastReceiptAt,
  };
}

/**
 * Apply period sales attribution (spec §16). Writes idempotent PayrollSalesAttribution rows
 * (dedupeKey per physical receipt + type) linked to each employee's calc, then updates the
 * calc's automatic/effective sales snapshot. The formula recompute is left to the caller
 * (payroll action) so this stays a pure attribution writer. Returns per-employee net sales.
 */
export async function applyPeriodSales(args: { companyId: string; clubId: string; year: number; month: number; payrollPeriodId: string; calcByEmployee: Map<string, string>; assignedById: string }): Promise<Map<string, number>> {
  const { companyId, clubId, year, month } = args;
  const { start, end } = monthRange(year, month);
  const receipts = await prisma.ofdReceiptImport.findMany({
    where: { companyId, clubId, receiptDate: { gte: start, lt: end }, operationType: { in: ["income", "income_return"] } },
    select: { id: true, provider: true, connectionId: true, fnNumber: true, fiscalDocumentNumber: true, fiscalSign: true, operationType: true, operatorNormalized: true, receiptDate: true, totalKopeks: true },
    orderBy: { receiptDate: "asc" },
  });
  const net = new Map<string, number>();
  for (const r of receipts) {
    const fp = receiptFiscalFingerprint(r);
    if (r.operationType === "income") {
      const emp = await resolveSaleEmployee(companyId, r);
      if (!emp) continue;
      await upsertAttribution({ companyId, clubId, employeeId: emp, payrollPeriodId: args.payrollPeriodId, payrollCalculationId: args.calcByEmployee.get(emp) ?? null, ofdReceiptId: r.id, attributionType: "personal_sale", amountKopeks: r.totalKopeks, originalSaleReceiptId: null, dedupeKey: attributionDedupeKey(fp, "personal_sale"), assignedById: args.assignedById });
      net.set(emp, (net.get(emp) ?? 0) + r.totalKopeks);
    } else {
      const orig = await resolveRefundOriginalEmployee(companyId, r);
      if (!orig) continue; // unmatched refund stays out of automatic totals (manual queue)
      await upsertAttribution({ companyId, clubId, employeeId: orig.employeeId, payrollPeriodId: args.payrollPeriodId, payrollCalculationId: args.calcByEmployee.get(orig.employeeId) ?? null, ofdReceiptId: r.id, attributionType: "refund", amountKopeks: -r.totalKopeks, originalSaleReceiptId: orig.originalReceiptId, dedupeKey: attributionDedupeKey(fp, "refund"), assignedById: args.assignedById });
      net.set(orig.employeeId, (net.get(orig.employeeId) ?? 0) - r.totalKopeks);
    }
  }
  return net;
}

async function upsertAttribution(a: { companyId: string; clubId: string; employeeId: string; payrollPeriodId: string; payrollCalculationId: string | null; ofdReceiptId: string; attributionType: string; amountKopeks: number; originalSaleReceiptId: string | null; dedupeKey: string; assignedById: string }): Promise<void> {
  // Idempotent: dedupeKey @unique guarantees one physical receipt affects one type once.
  const existing = await prisma.payrollSalesAttribution.findUnique({ where: { dedupeKey: a.dedupeKey } });
  if (existing) {
    await prisma.payrollSalesAttribution.update({ where: { id: existing.id }, data: { employeeId: a.employeeId, amountKopeks: a.amountKopeks, payrollCalculationId: a.payrollCalculationId, payrollPeriodId: a.payrollPeriodId, status: "attributed" } });
    return;
  }
  await prisma.payrollSalesAttribution.create({ data: { ...a, source: "ofd_confirmed", status: "attributed" } });
}

/** Sum of attributed net sales for an employee's calc (from stored attributions). */
export async function attributedNetForCalc(calculationId: string): Promise<number> {
  const rows = await prisma.payrollSalesAttribution.findMany({ where: { payrollCalculationId: calculationId, status: "attributed" }, select: { amountKopeks: true } });
  return rows.reduce((s, r) => s + r.amountKopeks, 0);
}
