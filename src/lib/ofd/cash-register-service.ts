// Cash-register (KKT mapping) management: usage counts, effective-dated binding history,
// FN history, and safe delete/archive/purge decisions. Imported receipts snapshot their own
// club/legalEntity/fn at import, so binding changes NEVER rewrite history — this service only
// tracks the CURRENT binding + an explicit audit trail. No money movement.
import type { Prisma, PrismaClient, OfdCashRegisterMapping } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = PrismaClient | Prisma.TransactionClient;

export type CashRegisterUsage = {
  receipts: number;
  items: number;
  identities: number;
  attributions: number;
  firstReceiptAt: Date | null;
  lastReceiptAt: Date | null;
  usedInClosedPeriod: boolean;
};

/** Count everything tied to a KKT's fiscal drive (by companyId + provider + fnNumber). */
export async function cashRegisterUsage(mapping: Pick<OfdCashRegisterMapping, "companyId" | "provider" | "fnNumber" | "connectionId">): Promise<CashRegisterUsage> {
  const { companyId, provider, fnNumber, connectionId } = mapping;
  const [receipts, items, identities, agg] = await Promise.all([
    prisma.ofdReceiptImport.findMany({ where: { companyId, provider, fnNumber }, select: { id: true, receiptDate: true } }),
    prisma.ofdReceiptItem.count({ where: { companyId, provider, fnNumber } }),
    prisma.ofdCashierIdentity.count({ where: { companyId, ofdConnectionId: connectionId, identityKey: { contains: `|${fnNumber}|` } } }),
    prisma.ofdReceiptImport.aggregate({ where: { companyId, provider, fnNumber }, _min: { receiptDate: true }, _max: { receiptDate: true } }),
  ]);
  const receiptIds = receipts.map((r) => r.id);
  const attributions = receiptIds.length ? await prisma.payrollSalesAttribution.count({ where: { companyId, ofdReceiptId: { in: receiptIds } } }) : 0;
  // "Used in a closed payroll period" — any attribution whose period is closed.
  let usedInClosedPeriod = false;
  if (receiptIds.length) {
    const attrs = await prisma.payrollSalesAttribution.findMany({ where: { companyId, ofdReceiptId: { in: receiptIds }, payrollPeriodId: { not: null } }, select: { payrollPeriodId: true } });
    const periodIds = [...new Set(attrs.map((a) => a.payrollPeriodId).filter((x): x is string => !!x))];
    if (periodIds.length) {
      usedInClosedPeriod = (await prisma.payrollPeriod.count({ where: { id: { in: periodIds }, status: "closed" } })) > 0;
    }
  }
  return { receipts: receipts.length, items, identities, attributions, firstReceiptAt: agg._min.receiptDate, lastReceiptAt: agg._max.receiptDate, usedInClosedPeriod };
}

/** True if the KKT has any imported history → cannot be hard-deleted (archive instead). */
export function hasBlockingHistory(u: CashRegisterUsage): boolean {
  return u.receipts > 0 || u.items > 0 || u.identities > 0 || u.attributions > 0;
}

/**
 * Close the current open assignment (if any) and open a new one from `effectiveFrom` — the
 * explicit binding history. Called on any change of club / legalEntity / connection / type.
 * End-exclusive intervals. Idempotent-safe: only opens a new row when the binding differs.
 */
export async function recordAssignmentChange(
  db: Db,
  args: { mapping: OfdCashRegisterMapping; clubId: string; legalEntityId: string | null; connectionId: string; cashRegisterType: string; effectiveFrom: Date; createdById: string; reason?: string | null },
): Promise<void> {
  const open = await db.ofdCashRegisterAssignment.findFirst({ where: { cashRegisterMappingId: args.mapping.id, effectiveTo: null }, orderBy: { effectiveFrom: "desc" } });
  const same = open && open.clubId === args.clubId && open.legalEntityId === args.legalEntityId && open.connectionId === args.connectionId && open.cashRegisterType === args.cashRegisterType;
  if (same) return;
  if (open) {
    await db.ofdCashRegisterAssignment.update({ where: { id: open.id }, data: { effectiveTo: args.effectiveFrom < open.effectiveFrom ? open.effectiveFrom : args.effectiveFrom } });
  }
  await db.ofdCashRegisterAssignment.create({
    data: { companyId: args.mapping.companyId, cashRegisterMappingId: args.mapping.id, clubId: args.clubId, legalEntityId: args.legalEntityId, connectionId: args.connectionId, cashRegisterType: args.cashRegisterType, effectiveFrom: args.effectiveFrom, createdById: args.createdById, reason: args.reason ?? null },
  });
}

/** Replace the current active fiscal drive with a new one, keeping the old in history. */
export async function recordFiscalDriveChange(
  db: Db,
  args: { mapping: OfdCashRegisterMapping; fiscalDriveNumber: string; registrationNumber: string | null; effectiveFrom: Date; externalId?: string | null },
): Promise<void> {
  const current = await db.ofdFiscalDrive.findFirst({ where: { cashRegisterMappingId: args.mapping.id, status: "active" }, orderBy: { createdAt: "desc" } });
  if (current && current.fiscalDriveNumber === args.fiscalDriveNumber) return;
  if (current) {
    await db.ofdFiscalDrive.update({ where: { id: current.id }, data: { status: "replaced", validTo: args.effectiveFrom } });
  }
  await db.ofdFiscalDrive.create({
    data: { companyId: args.mapping.companyId, provider: args.mapping.provider, connectionId: args.mapping.connectionId, cashRegisterMappingId: args.mapping.id, fiscalDriveNumber: args.fiscalDriveNumber, registrationNumber: args.registrationNumber, validFrom: args.effectiveFrom, status: "active", externalId: args.externalId ?? null },
  });
}

/** Ensure an initial "active" fiscal-drive + assignment row exists for a mapping (idempotent). */
export async function ensureInitialHistory(db: Db, mapping: OfdCashRegisterMapping, createdById: string): Promise<void> {
  const [fd, asg] = await Promise.all([
    db.ofdFiscalDrive.count({ where: { cashRegisterMappingId: mapping.id } }),
    db.ofdCashRegisterAssignment.count({ where: { cashRegisterMappingId: mapping.id } }),
  ]);
  const now = mapping.createdAt ?? new Date();
  if (fd === 0) await db.ofdFiscalDrive.create({ data: { companyId: mapping.companyId, provider: mapping.provider, connectionId: mapping.connectionId, cashRegisterMappingId: mapping.id, fiscalDriveNumber: mapping.fnNumber, registrationNumber: mapping.kktRegNumber, validFrom: now, status: "active" } });
  if (asg === 0) await db.ofdCashRegisterAssignment.create({ data: { companyId: mapping.companyId, cashRegisterMappingId: mapping.id, clubId: mapping.clubId, legalEntityId: mapping.legalEntityId, connectionId: mapping.connectionId, cashRegisterType: mapping.registerKind, effectiveFrom: now, createdById } });
}
