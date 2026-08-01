// Unified, month-filterable READ MODEL for the Collections history. Assembles rows from
// EXISTING entities (no new table): fact reconciliations, control points (set / correction /
// cancellation), ООО collections, ООО→ИП withdrawals, ИП «Иное», regional transfers. Also
// returns per-month movement totals. Filtering NEVER touches the current-balance cards —
// only the history/monthly rows. Integer kopeks; club-local calendar boundaries.
import { prisma } from "@/lib/prisma";
import { getActiveClubLegalEntities, type LegalEntityType } from "@/lib/legal-entities";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** [start, end) of a YYYY-MM in club-local calendar time; null → no month filter. */
export function monthBounds(month: string | null): { start: Date; end: Date } | null {
  const m = month ? /^(\d{4})-(\d{2})$/.exec(month) : null;
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1;
  return { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 1) };
}
const inMonth = (d: Date, b: { start: Date; end: Date } | null) => (b === null ? true : d >= b.start && d < b.end);

export type UnifiedHistoryRow = {
  id: string;
  kind: "reconciliation" | "snapshot" | "collection" | "withdrawal" | "other_income" | "transfer";
  subtype: string | null; // snapshot: set|correction|cancellation
  typeLabel: string;
  effectiveDate: Date;
  createdAt: Date;
  entity: LegalEntityType | null; // ooo | ip | null
  amountKopeks: number;
  sign: "in" | "out" | "fact";
  clubId: string;
  counterparty: string | null; // source (Иное) / recipient (transfer)
  status: string;
  createdById: string;
  confirmedById: string | null;
  comment: string | null;
  documents: number;
};

export type CollectionsMonthTotals = {
  ofdCashOooKopeks: number; ofdCashIpKopeks: number;
  collectionsKopeks: number; withdrawalsKopeks: number; otherIncomeKopeks: number;
  transfersConfirmedKopeks: number; ipCashExpensesKopeks: number; reconciliationsCount: number;
};

const TYPE_LABEL: Record<string, string> = {
  reconciliation: "Фактическая сверка", collection: "Инкассация ООО", withdrawal: "Изъятие ООО→ИП",
  other_income: "Приход «Иное»", transfer: "Передача регионалу",
};
const SNAP_LABEL: Record<string, string> = { set: "Контрольная точка", correction: "Корректировка точки", cancellation: "Отмена точки" };

export async function loadCollectionsHistory(
  companyId: string,
  clubIds: string[],
  month: string | null,
): Promise<{ rows: UnifiedHistoryRow[]; totals: CollectionsMonthTotals }> {
  const empty: CollectionsMonthTotals = { ofdCashOooKopeks: 0, ofdCashIpKopeks: 0, collectionsKopeks: 0, withdrawalsKopeks: 0, otherIncomeKopeks: 0, transfersConfirmedKopeks: 0, ipCashExpensesKopeks: 0, reconciliationsCount: 0 };
  if (clubIds.length === 0) return { rows: [], totals: empty };
  const b = monthBounds(month);

  // Entity type per club (for tagging snapshots/recon/ofd). Small N of clubs.
  const entityTypeByLE = new Map<string, LegalEntityType>();
  await Promise.all(clubIds.map(async (cid) => {
    const { ooo, ip } = await getActiveClubLegalEntities(cid);
    if (ooo) entityTypeByLE.set(ooo.id, "ooo");
    if (ip) entityTypeByLE.set(ip.id, "ip");
  }));

  const [collections, withdrawals, otherIncome, transfers, snapshots, recons, ofd, ipExpenses, colDocs, wdDocs, oiDocs] = await Promise.all([
    prisma.cashCollection.findMany({ where: { companyId, clubId: { in: clubIds } }, select: { id: true, clubId: true, amountKopeks: true, operationDate: true, status: true, comment: true, createdByUserId: true } }),
    prisma.cashWithdrawal.findMany({ where: { companyId, clubId: { in: clubIds } }, select: { id: true, clubId: true, amountKopeks: true, operationDate: true, status: true, comment: true, createdByUserId: true } }),
    prisma.cashOtherIncome.findMany({ where: { companyId, clubId: { in: clubIds } }, select: { id: true, clubId: true, amountKopeks: true, operationDate: true, status: true, comment: true, createdByUserId: true, source: true } }),
    prisma.cashRegionalTransfer.findMany({ where: { companyId, clubId: { in: clubIds } }, select: { id: true, clubId: true, amountKopeks: true, operationDate: true, status: true, comment: true, createdById: true, confirmedById: true, recipientNameSnapshot: true } }),
    prisma.balanceSnapshot.findMany({ where: { companyId, clubId: { in: clubIds } }, select: { id: true, clubId: true, legalEntityId: true, actualBalanceKopeks: true, snapshotDate: true, status: true, supersedesSnapshotId: true, comment: true, correctionReason: true, cancellationReason: true, createdById: true, createdAt: true } }),
    prisma.dailyCashReconciliation.findMany({ where: { companyId, clubId: { in: clubIds } }, select: { id: true, clubId: true, legalEntityType: true, actualCashBalanceKopeks: true, businessDate: true, status: true, submittedById: true, comment: true, createdAt: true } }),
    prisma.ofdDailySalesSummary.findMany({ where: { companyId, clubId: { in: clubIds }, provider: "taxcom" }, select: { legalEntityId: true, date: true, incomeCashKopeks: true, returnCashKopeks: true } }),
    prisma.expense.findMany({ where: { companyId, clubId: { in: clubIds }, paymentMethod: "cash", entryVersion: 2 }, select: { id: true, legalEntityId: true, amountKopeks: true, expenseDate: true, status: true } }),
    prisma.cashOperationDocument.groupBy({ by: ["collectionId"], where: { companyId, clubId: { in: clubIds }, removedAt: null, collectionId: { not: null } }, _count: { _all: true } }),
    prisma.cashOperationDocument.groupBy({ by: ["withdrawalId"], where: { companyId, clubId: { in: clubIds }, removedAt: null, withdrawalId: { not: null } }, _count: { _all: true } }),
    prisma.cashOperationDocument.groupBy({ by: ["otherIncomeId"], where: { companyId, clubId: { in: clubIds }, removedAt: null, otherIncomeId: { not: null } }, _count: { _all: true } }),
  ]);
  const colDoc = new Map(colDocs.map((d) => [d.collectionId, d._count._all]));
  const wdDoc = new Map(wdDocs.map((d) => [d.withdrawalId, d._count._all]));
  const oiDoc = new Map(oiDocs.map((d) => [d.otherIncomeId, d._count._all]));

  const rows: UnifiedHistoryRow[] = [];
  for (const c of collections) if (inMonth(c.operationDate, b)) rows.push({ id: c.id, kind: "collection", subtype: null, typeLabel: TYPE_LABEL.collection, effectiveDate: c.operationDate, createdAt: c.operationDate, entity: "ooo", amountKopeks: c.amountKopeks, sign: "out", clubId: c.clubId, counterparty: null, status: c.status, createdById: c.createdByUserId, confirmedById: null, comment: c.comment, documents: colDoc.get(c.id) ?? 0 });
  for (const w of withdrawals) if (inMonth(w.operationDate, b)) rows.push({ id: w.id, kind: "withdrawal", subtype: null, typeLabel: TYPE_LABEL.withdrawal, effectiveDate: w.operationDate, createdAt: w.operationDate, entity: "ooo", amountKopeks: w.amountKopeks, sign: "out", clubId: w.clubId, counterparty: "ИП", status: w.status, createdById: w.createdByUserId, confirmedById: null, comment: w.comment, documents: wdDoc.get(w.id) ?? 0 });
  for (const o of otherIncome) if (inMonth(o.operationDate, b)) rows.push({ id: o.id, kind: "other_income", subtype: null, typeLabel: TYPE_LABEL.other_income, effectiveDate: o.operationDate, createdAt: o.operationDate, entity: "ip", amountKopeks: o.amountKopeks, sign: "in", clubId: o.clubId, counterparty: o.source, status: o.status, createdById: o.createdByUserId, confirmedById: null, comment: o.comment, documents: oiDoc.get(o.id) ?? 0 });
  for (const t of transfers) if (inMonth(t.operationDate, b)) rows.push({ id: t.id, kind: "transfer", subtype: null, typeLabel: TYPE_LABEL.transfer, effectiveDate: t.operationDate, createdAt: t.operationDate, entity: "ip", amountKopeks: t.amountKopeks, sign: t.status === "confirmed" ? "out" : "fact", clubId: t.clubId, counterparty: t.recipientNameSnapshot, status: t.status, createdById: t.createdById, confirmedById: t.confirmedById, comment: t.comment, documents: 0 });
  for (const s of snapshots) if (inMonth(s.snapshotDate, b)) {
    const subtype = s.status === "cancelled" ? "cancellation" : s.supersedesSnapshotId ? "correction" : "set";
    rows.push({ id: s.id, kind: "snapshot", subtype, typeLabel: SNAP_LABEL[subtype], effectiveDate: s.snapshotDate, createdAt: s.createdAt, entity: entityTypeByLE.get(s.legalEntityId) ?? null, amountKopeks: s.actualBalanceKopeks, sign: "fact", clubId: s.clubId, counterparty: null, status: s.status, createdById: s.createdById, confirmedById: null, comment: s.cancellationReason ?? s.correctionReason ?? s.comment, documents: 0 });
  }
  for (const r of recons) if (inMonth(r.businessDate, b)) rows.push({ id: r.id, kind: "reconciliation", subtype: null, typeLabel: TYPE_LABEL.reconciliation, effectiveDate: r.businessDate, createdAt: r.createdAt, entity: r.legalEntityType as LegalEntityType, amountKopeks: r.actualCashBalanceKopeks, sign: "fact", clubId: r.clubId, counterparty: null, status: r.status, createdById: r.submittedById ?? "", confirmedById: null, comment: r.comment, documents: 0 });

  rows.sort((x, y) => (y.effectiveDate.getTime() - x.effectiveDate.getTime()) || (y.createdAt.getTime() - x.createdAt.getTime()));

  // Month totals (movement categories + OFD cash net). Integer kopeks only.
  const totals: CollectionsMonthTotals = { ...empty };
  for (const c of collections) if (inMonth(c.operationDate, b) && (c.status === "pending_accountant_review" || c.status === "approved")) totals.collectionsKopeks += c.amountKopeks;
  for (const w of withdrawals) if (inMonth(w.operationDate, b) && (w.status === "pending_review" || w.status === "approved")) totals.withdrawalsKopeks += w.amountKopeks;
  for (const o of otherIncome) if (inMonth(o.operationDate, b) && (o.status === "pending_review" || o.status === "approved")) totals.otherIncomeKopeks += o.amountKopeks;
  for (const t of transfers) if (inMonth(t.operationDate, b) && t.status === "confirmed") totals.transfersConfirmedKopeks += t.amountKopeks;
  for (const e of ipExpenses) if (inMonth(e.expenseDate, b) && e.status !== "draft" && e.status !== "cancelled" && e.status !== "canceled") totals.ipCashExpensesKopeks += e.amountKopeks;
  totals.reconciliationsCount = recons.filter((r) => inMonth(r.businessDate, b)).length;
  for (const r of ofd) {
    if (!inMonth(new Date(`${r.date}T00:00:00`), b)) continue;
    const net = (r.incomeCashKopeks || 0) - (r.returnCashKopeks || 0);
    const type = r.legalEntityId ? entityTypeByLE.get(r.legalEntityId) : null;
    if (type === "ooo") totals.ofdCashOooKopeks += net; else if (type === "ip") totals.ofdCashIpKopeks += net;
  }
  return { rows, totals };
}
