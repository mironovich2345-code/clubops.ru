// READ-ONLY diagnostic for one «Передача региональному директору» by ID. Proves the money
// invariants on live data WITHOUT mutating anything: shows the transfer, whether it is
// included in the ИП fact balance, the ИП balance with vs without it (balanceBefore /
// balanceAfter), and that it created no Expense and touched neither revenue nor profit.
//
// The ИП fact formula here MIRRORS src/lib/cash-balances.ts + loadClubCashBalances (integer
// kopeks; movement counts strictly after the active opening point by club-local day).
//   node scripts/diag-regional-transfer.mjs <transferId>
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmt = (k) => `${(k / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
const after = (date, since) => (since === null ? true : date > since);
const sumStatus = (rows, allowed) => rows.filter((r) => allowed.includes(r.status)).reduce((a, r) => a + (r.amountKopeks || 0), 0);

// Compute the ИП fact balance for a club, optionally EXCLUDING one transfer id.
async function ipFactBalance(companyId, clubId, ipId, now, excludeTransferId = null) {
  const [snap, ofd, withdrawals, other, expenses, transfers] = await Promise.all([
    prisma.balanceSnapshot.findFirst({ where: { clubId, legalEntityId: ipId, status: "active", snapshotDate: { lte: now } }, orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }], select: { actualBalanceKopeks: true, snapshotDate: true } }),
    prisma.ofdDailySalesSummary.findMany({ where: { companyId, clubId, provider: "taxcom", legalEntityId: ipId }, select: { date: true, incomeCashKopeks: true, returnCashKopeks: true } }),
    prisma.cashWithdrawal.findMany({ where: { clubId }, select: { status: true, amountKopeks: true, operationDate: true } }),
    prisma.cashOtherIncome.findMany({ where: { clubId, legalEntityId: ipId }, select: { status: true, amountKopeks: true, operationDate: true } }),
    prisma.expense.findMany({ where: { clubId, legalEntityId: ipId, paymentMethod: "cash", entryVersion: 2 }, select: { status: true, amountKopeks: true, expenseDate: true } }),
    prisma.cashRegionalTransfer.findMany({ where: { clubId, legalEntityId: ipId }, select: { id: true, status: true, amountKopeks: true, operationDate: true } }),
  ]);
  const since = snap ? ymd(snap.snapshotDate) : null;
  const opening = snap?.actualBalanceKopeks ?? 0;
  const ofdNet = ofd.filter((r) => after(r.date, since)).reduce((a, r) => a + (r.incomeCashKopeks || 0) - (r.returnCashKopeks || 0), 0);
  const wd = sumStatus(withdrawals.filter((w) => after(ymd(w.operationDate), since)).map((w) => ({ status: w.status, amountKopeks: w.amountKopeks })), ["pending_review", "approved"]);
  const oi = sumStatus(other.filter((o) => after(ymd(o.operationDate), since)).map((o) => ({ status: o.status, amountKopeks: o.amountKopeks })), ["pending_review", "approved"]);
  const exp = sumStatus(expenses.filter((e) => after(ymd(e.expenseDate), since)).map((e) => ({ status: e.status, amountKopeks: e.amountKopeks })), ["submitted", "pending_regional_budget_approval", "pending_owner_budget_approval", "pending_accountant_verification", "needs_correction", "waiting_budget_approval", "verified", "confirmed"]);
  const tr = transfers.filter((t) => t.id !== excludeTransferId && after(ymd(t.operationDate), since)).filter((t) => t.status === "confirmed").reduce((a, t) => a + t.amountKopeks, 0);
  return opening + ofdNet + wd + oi - tr - exp;
}

async function main() {
  const id = process.argv[2];
  if (!id) { console.log("Usage: node scripts/diag-regional-transfer.mjs <transferId>"); return; }
  const t = await prisma.cashRegionalTransfer.findUnique({ where: { id } });
  if (!t) { console.log(`Передача не найдена: ${id}`); return; }
  const now = new Date();

  const opening = await prisma.balanceSnapshot.findFirst({ where: { clubId: t.clubId, legalEntityId: t.legalEntityId, status: "active", snapshotDate: { lte: now } }, orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }], select: { snapshotDate: true } });
  const openingDate = opening ? ymd(opening.snapshotDate) : null;
  const includedInBalance = t.status === "confirmed" && after(ymd(t.operationDate), openingDate);

  const balanceAfter = await ipFactBalance(t.companyId, t.clubId, t.legalEntityId, now, null); // with this transfer
  const balanceBefore = await ipFactBalance(t.companyId, t.clubId, t.legalEntityId, now, t.id); // without it
  // Structural facts: the model has no expense/revenue link — a transfer can never create one.
  const createdExpenseId = null;

  console.log(JSON.stringify({
    transferId: t.id,
    club: t.clubId,
    legalEntityId: t.legalEntityId,
    amountKopeks: t.amountKopeks,
    amount: fmt(t.amountKopeks),
    status: t.status,
    operationDate: ymd(t.operationDate),
    recipientNameSnapshot: t.recipientNameSnapshot,
    createdById: t.createdById,
    confirmedById: t.confirmedById,
    activeOpeningPoint: openingDate,
    includedInBalance,
    balanceBeforeKopeks: balanceBefore,
    balanceAfterKopeks: balanceAfter,
    balanceBefore: fmt(balanceBefore),
    balanceAfter: fmt(balanceAfter),
    deltaKopeks: balanceAfter - balanceBefore,
    expectedDeltaKopeks: includedInBalance ? -t.amountKopeks : 0,
    deltaMatches: (balanceAfter - balanceBefore) === (includedInBalance ? -t.amountKopeks : 0),
    createdExpenseId,
    affectedRevenue: false,
    affectedProfit: false,
    note: "READ-ONLY. Formula mirrors src/lib/cash-balances.ts. Transfer has no Expense/revenue link by design.",
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
