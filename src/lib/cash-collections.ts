// Server-side loader for the managerial cash contour. Reads the SAFE aggregate
// inputs (opening snapshots, OFD cash by legal entity, collections, withdrawals,
// ИП cash expenses) and delegates the math to the pure calculateCashBalances.
// No raw fiscal data, no secrets, no PII.
import { prisma } from "@/lib/prisma";
import { getActiveClubLegalEntities, type LegalEntityType } from "@/lib/legal-entities";
import { calculateCashBalances, type CashBalances, type OfdCashRow, type StatusAmount } from "@/lib/cash-balances";

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

/** Fact balances for ONE club's ООО and ИП cash. OFD cash and cash operations are
 * counted only after the latest opening-balance snapshot (so the snapshot is a real
 * baseline, not double-counted). */
export async function loadClubCashBalances(companyId: string, clubId: string, now: Date = new Date()): Promise<ClubCashResult> {
  const { ooo, ip } = await getActiveClubLegalEntities(clubId);
  const oooId = ooo?.id ?? null;
  const ipId = ip?.id ?? null;
  const entityIds = [oooId, ipId].filter((x): x is string => Boolean(x));
  const typeById = new Map<string, LegalEntityType>();
  if (oooId) typeById.set(oooId, "ooo");
  if (ipId) typeById.set(ipId, "ip");

  const [snapshots, ofd, collections, withdrawals, ipExpenses] = await Promise.all([
    entityIds.length
      ? prisma.balanceSnapshot.findMany({ where: { clubId, legalEntityId: { in: entityIds } }, orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }], select: { legalEntityId: true, actualBalanceKopeks: true, snapshotDate: true } })
      : Promise.resolve([]),
    prisma.ofdDailySalesSummary.findMany({ where: { companyId, clubId, provider: "taxcom" }, select: { legalEntityId: true, date: true, incomeCashKopeks: true, returnCashKopeks: true } }),
    prisma.cashCollection.findMany({ where: { clubId }, select: { status: true, amountKopeks: true, operationDate: true } }),
    prisma.cashWithdrawal.findMany({ where: { clubId }, select: { status: true, amountKopeks: true, operationDate: true } }),
    ipId
      ? prisma.expense.findMany({ where: { clubId, legalEntityId: ipId, paymentMethod: "cash", entryVersion: 2 }, select: { status: true, amountKopeks: true, expenseDate: true } })
      : Promise.resolve([]),
  ]);

  // Latest snapshot per entity (rows already desc-ordered → first wins), and the
  // club-wide baseline date after which OFD/operations count.
  const openingByEntity = new Map<string, number>();
  let sinceDate: Date | null = null;
  for (const s of snapshots) {
    if (!openingByEntity.has(s.legalEntityId)) openingByEntity.set(s.legalEntityId, s.actualBalanceKopeks);
    if (!sinceDate || s.snapshotDate > sinceDate) sinceDate = s.snapshotDate;
  }
  const sinceYmd = sinceDate ? ymdLocal(sinceDate) : null;
  const afterBaseline = (d: Date) => (sinceDate ? d > sinceDate : true);

  const ofdRows: OfdCashRow[] = ofd
    .filter((r) => (sinceYmd ? r.date > sinceYmd : true))
    .map((r) => ({ legalEntityType: r.legalEntityId ? typeById.get(r.legalEntityId) ?? null : null, date: r.date, incomeCashKopeks: r.incomeCashKopeks, returnCashKopeks: r.returnCashKopeks }));

  const balances = calculateCashBalances({
    oooOpeningKopeks: oooId ? openingByEntity.get(oooId) ?? 0 : 0,
    ipOpeningKopeks: ipId ? openingByEntity.get(ipId) ?? 0 : 0,
    ofdRows,
    yesterday: ymdLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)),
    collections: collections.filter((c) => afterBaseline(c.operationDate)).map((c) => ({ status: c.status, amountKopeks: c.amountKopeks })) as StatusAmount[],
    withdrawals: withdrawals.filter((w) => afterBaseline(w.operationDate)).map((w) => ({ status: w.status, amountKopeks: w.amountKopeks })) as StatusAmount[],
    ipExpenses: ipExpenses.filter((e) => afterBaseline(e.expenseDate)).map((e) => ({ status: e.status, amountKopeks: e.amountKopeks })) as StatusAmount[],
    ipOtherIncomeKopeks: 0,
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

/** Pending collections + withdrawals across a scope (for the accountant surface and
 * dashboard "на проверке" counters). SAFE fields only. */
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
