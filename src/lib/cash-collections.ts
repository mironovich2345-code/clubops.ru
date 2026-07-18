// Server-side loader for the managerial cash contour. Reads the SAFE aggregate
// inputs (opening snapshots + their dates, OFD cash by legal entity, collections,
// withdrawals, ИП cash expenses, confirmed «Иное») and delegates the math to the
// pure calculateCashBalances. Single source of truth for /collections, /expenses
// and the dashboard. No raw fiscal data, no secrets, no PII.
import { prisma } from "@/lib/prisma";
import { getActiveClubLegalEntities, type LegalEntityType } from "@/lib/legal-entities";
import { calculateCashBalances, type CashBalances } from "@/lib/cash-balances";

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type ClubCashResult = {
  balances: CashBalances;
  oooId: string | null;
  ipId: string | null;
  oooName: string | null;
  ipName: string | null;
};

/** Fact balances for ONE club's ООО and ИП cash, measured from the latest opening
 * checkpoint (BalanceSnapshot) per legal entity. */
export async function loadClubCashBalances(companyId: string, clubId: string, now: Date = new Date()): Promise<ClubCashResult> {
  const { ooo, ip } = await getActiveClubLegalEntities(clubId);
  const oooId = ooo?.id ?? null;
  const ipId = ip?.id ?? null;
  const entityIds = [oooId, ipId].filter((x): x is string => Boolean(x));
  const typeById = new Map<string, LegalEntityType>();
  if (oooId) typeById.set(oooId, "ooo");
  if (ipId) typeById.set(ipId, "ip");

  const [snapshots, ofd, collections, withdrawals, ipExpenses, otherIncome] = await Promise.all([
    entityIds.length
      ? prisma.balanceSnapshot.findMany({ where: { clubId, legalEntityId: { in: entityIds } }, orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }], select: { legalEntityId: true, actualBalanceKopeks: true, snapshotDate: true } })
      : Promise.resolve([]),
    prisma.ofdDailySalesSummary.findMany({ where: { companyId, clubId, provider: "taxcom" }, select: { legalEntityId: true, date: true, incomeCashKopeks: true, returnCashKopeks: true } }),
    prisma.cashCollection.findMany({ where: { clubId }, select: { status: true, amountKopeks: true, operationDate: true } }),
    prisma.cashWithdrawal.findMany({ where: { clubId }, select: { status: true, amountKopeks: true, operationDate: true } }),
    ipId
      ? prisma.expense.findMany({ where: { clubId, legalEntityId: ipId, paymentMethod: "cash", entryVersion: 2 }, select: { status: true, amountKopeks: true, expenseDate: true } })
      : Promise.resolve([]),
    ipId
      ? prisma.cashMovement.findMany({ where: { clubId, legalEntityId: ipId, type: "other_cash_income", status: "confirmed" }, select: { amountKopeks: true, occurredAt: true } })
      : Promise.resolve([]),
  ]);

  // Latest snapshot per entity (rows already desc-ordered → first wins).
  const openingByEntity = new Map<string, { amount: number; date: string }>();
  for (const s of snapshots) if (!openingByEntity.has(s.legalEntityId)) openingByEntity.set(s.legalEntityId, { amount: s.actualBalanceKopeks, date: ymdLocal(s.snapshotDate) });
  const oooOpen = oooId ? openingByEntity.get(oooId) ?? null : null;
  const ipOpen = ipId ? openingByEntity.get(ipId) ?? null : null;

  const now2 = now;
  const balances = calculateCashBalances({
    oooOpeningKopeks: oooOpen?.amount ?? 0,
    ipOpeningKopeks: ipOpen?.amount ?? 0,
    oooOpeningDate: oooOpen?.date ?? null,
    ipOpeningDate: ipOpen?.date ?? null,
    ofdRows: ofd.map((r) => ({ legalEntityType: r.legalEntityId ? typeById.get(r.legalEntityId) ?? null : null, date: r.date, incomeCashKopeks: r.incomeCashKopeks, returnCashKopeks: r.returnCashKopeks })),
    today: ymdLocal(now2),
    yesterday: ymdLocal(new Date(now2.getFullYear(), now2.getMonth(), now2.getDate() - 1)),
    monthPrefix: `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, "0")}`,
    collections: collections.map((c) => ({ status: c.status, amountKopeks: c.amountKopeks, date: ymdLocal(c.operationDate) })),
    withdrawals: withdrawals.map((w) => ({ status: w.status, amountKopeks: w.amountKopeks, date: ymdLocal(w.operationDate) })),
    ipExpenses: ipExpenses.map((e) => ({ status: e.status, amountKopeks: e.amountKopeks, date: ymdLocal(e.expenseDate) })),
    ipOtherIncome: otherIncome.map((o) => ({ amountKopeks: o.amountKopeks, date: ymdLocal(o.occurredAt) })),
  });

  return { balances, oooId, ipId, oooName: ooo?.name ?? null, ipName: ip?.name ?? null };
}

export type PendingCashOp = {
  id: string;
  kind: "collection" | "withdrawal";
  clubId: string;
  amountKopeks: number;
  operationDate: Date;
  status: string;
  comment: string | null;
};

/** Pending collections + withdrawals across a scope (dashboard/workspace counters). */
export async function loadPendingCashOps(companyId: string, clubIds: string[]): Promise<PendingCashOp[]> {
  if (clubIds.length === 0) return [];
  const [collections, withdrawals] = await Promise.all([
    prisma.cashCollection.findMany({ where: { companyId, clubId: { in: clubIds }, status: "pending_accountant_review" }, select: { id: true, clubId: true, amountKopeks: true, operationDate: true, status: true, comment: true } }),
    prisma.cashWithdrawal.findMany({ where: { companyId, clubId: { in: clubIds }, status: "pending_review" }, select: { id: true, clubId: true, amountKopeks: true, operationDate: true, status: true, comment: true } }),
  ]);
  return [
    ...collections.map((c) => ({ id: c.id, kind: "collection" as const, clubId: c.clubId, amountKopeks: c.amountKopeks, operationDate: c.operationDate, status: c.status, comment: c.comment })),
    ...withdrawals.map((w) => ({ id: w.id, kind: "withdrawal" as const, clubId: w.clubId, amountKopeks: w.amountKopeks, operationDate: w.operationDate, status: w.status, comment: w.comment })),
  ].sort((a, b) => b.operationDate.getTime() - a.operationDate.getTime());
}

export type CashOpRow = {
  id: string;
  kind: "collection" | "withdrawal";
  clubId: string;
  amountKopeks: number;
  operationDate: Date;
  status: string;
  comment: string | null;
  createdByUserId: string;
  documents: number;
};

/** Full history of collections + withdrawals for a scope (all statuses), newest
 * first, with a safe document COUNT (never document contents). */
export async function loadCashOpsHistory(companyId: string, clubIds: string[], limit = 50): Promise<CashOpRow[]> {
  if (clubIds.length === 0) return [];
  const [collections, withdrawals, colDocs, wdDocs] = await Promise.all([
    prisma.cashCollection.findMany({ where: { companyId, clubId: { in: clubIds } }, orderBy: { operationDate: "desc" }, take: limit, select: { id: true, clubId: true, amountKopeks: true, operationDate: true, status: true, comment: true, createdByUserId: true } }),
    prisma.cashWithdrawal.findMany({ where: { companyId, clubId: { in: clubIds } }, orderBy: { operationDate: "desc" }, take: limit, select: { id: true, clubId: true, amountKopeks: true, operationDate: true, status: true, comment: true, createdByUserId: true } }),
    prisma.cashOperationDocument.groupBy({ by: ["collectionId"], where: { companyId, clubId: { in: clubIds }, removedAt: null, collectionId: { not: null } }, _count: { _all: true } }),
    prisma.cashOperationDocument.groupBy({ by: ["withdrawalId"], where: { companyId, clubId: { in: clubIds }, removedAt: null, withdrawalId: { not: null } }, _count: { _all: true } }),
  ]);
  const colDocCount = new Map(colDocs.map((d) => [d.collectionId, d._count._all]));
  const wdDocCount = new Map(wdDocs.map((d) => [d.withdrawalId, d._count._all]));
  return [
    ...collections.map((c) => ({ id: c.id, kind: "collection" as const, clubId: c.clubId, amountKopeks: c.amountKopeks, operationDate: c.operationDate, status: c.status, comment: c.comment, createdByUserId: c.createdByUserId, documents: colDocCount.get(c.id) ?? 0 })),
    ...withdrawals.map((w) => ({ id: w.id, kind: "withdrawal" as const, clubId: w.clubId, amountKopeks: w.amountKopeks, operationDate: w.operationDate, status: w.status, comment: w.comment, createdByUserId: w.createdByUserId, documents: wdDocCount.get(w.id) ?? 0 })),
  ]
    .sort((a, b) => b.operationDate.getTime() - a.operationDate.getTime())
    .slice(0, limit);
}

export type OpeningSnapshotRow = { legalEntityId: string; entityType: LegalEntityType | null; amountKopeks: number; snapshotDate: Date; comment: string | null; createdById: string; createdAt: Date };

/** Recent opening-balance checkpoints for a club (history: date, amount, comment,
 * author). Read-only; never edits existing rows. */
export async function loadClubOpeningHistory(clubId: string, limit = 20): Promise<OpeningSnapshotRow[]> {
  const { ooo, ip } = await getActiveClubLegalEntities(clubId);
  const typeById = new Map<string, LegalEntityType>();
  if (ooo) typeById.set(ooo.id, "ooo");
  if (ip) typeById.set(ip.id, "ip");
  const rows = await prisma.balanceSnapshot.findMany({ where: { clubId }, orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }], take: limit, select: { legalEntityId: true, actualBalanceKopeks: true, snapshotDate: true, comment: true, createdById: true, createdAt: true } });
  return rows.map((r) => ({ legalEntityId: r.legalEntityId, entityType: typeById.get(r.legalEntityId) ?? null, amountKopeks: r.actualBalanceKopeks, snapshotDate: r.snapshotDate, comment: r.comment, createdById: r.createdById, createdAt: r.createdAt }));
}
