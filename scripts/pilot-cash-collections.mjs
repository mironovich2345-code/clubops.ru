// Cash contour: fact balances (ООО/ИП) measured from the latest opening checkpoint,
// инкассация ООО, изъятие ООО→ИП. Mirrors src/lib/cash-balances.ts + the loader,
// plus DB round-trips and static source guards. Real Taxcom API is never called.
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? `  ${x}` : ""}`); c ? pass++ : fail++; };

const CO = "pilot-cash-co", CLUB = "pilot-cash-club", U = "pilot-cash-user";
const OOO = "pilot-cash-ooo", IP = "pilot-cash-ip";
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function cleanup() {
  await p.cashOperationDocument.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.cashCollection.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.cashWithdrawal.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.expense.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.ofdDailySalesSummary.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.balanceSnapshot.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.clubLegalEntity.deleteMany({ where: { legalEntity: { companyId: CO } } }).catch(() => {});
  await p.legalEntity.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.club.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.company.deleteMany({ where: { id: CO } }).catch(() => {});
  await p.user.deleteMany({ where: { id: U } }).catch(() => {});
}

// ---- Mirror of src/lib/cash-balances.ts (pure) ----------------------------
const COLLECTION_STATUS = { DRAFT: "draft", PENDING: "pending_accountant_review", APPROVED: "approved", REJECTED: "rejected", CANCELLED: "cancelled" };
const WITHDRAWAL_STATUS = { DRAFT: "draft", PENDING: "pending_review", APPROVED: "approved", REJECTED: "rejected", CANCELLED: "cancelled" };
const COLLECTION_FACT = [COLLECTION_STATUS.PENDING, COLLECTION_STATUS.APPROVED];
const WITHDRAWAL_FACT = [WITHDRAWAL_STATUS.PENDING, WITHDRAWAL_STATUS.APPROVED];
const IP_EXP_PENDING = ["submitted", "pending_regional_budget_approval", "pending_owner_budget_approval", "pending_accountant_verification", "needs_correction", "waiting_budget_approval"];
const IP_EXP_APPROVED = ["verified", "confirmed"];
const after = (date, since) => (since === null ? true : date > since);
const sum = (xs) => xs.reduce((a, x) => a + (x.amountKopeks || 0), 0);
const pick = (xs, allowed) => xs.filter((x) => allowed.includes(x.status));
const ofdNet = (rows, t, keep) => rows.filter((r) => r.legalEntityType === t && keep(r.date)).reduce((a, r) => a + (r.incomeCashKopeks || 0) - (r.returnCashKopeks || 0), 0);
function calc(i) {
  const other = i.ipOtherIncome ?? [];
  const ipSince = i.ipOpeningDate;
  const cashIpOpening = i.ipOpeningKopeks || 0;
  const cashIpOfdSinceOpening = ofdNet(i.ofdRows, "ip", (d) => after(d, ipSince));
  const cashIpOfdYesterday = ofdNet(i.ofdRows, "ip", (d) => d === i.yesterday);
  const cashIpOfdToday = ofdNet(i.ofdRows, "ip", (d) => d === i.today);
  const cashIpOfdMonth = ofdNet(i.ofdRows, "ip", (d) => d.startsWith(i.monthPrefix));
  const cashIpWithdrawalsFromOoo = sum(pick(i.withdrawals.filter((w) => after(w.date, ipSince)), WITHDRAWAL_FACT));
  const cashIpOtherIncome = sum(other.filter((o) => after(o.date, ipSince)));
  const cashIpPendingExpenses = sum(pick(i.ipExpenses.filter((e) => after(e.date, ipSince)), IP_EXP_PENDING));
  const cashIpApprovedExpenses = sum(pick(i.ipExpenses.filter((e) => after(e.date, ipSince)), IP_EXP_APPROVED));
  const cashIpFactBalance = cashIpOpening + cashIpOfdSinceOpening + cashIpWithdrawalsFromOoo + cashIpOtherIncome - cashIpPendingExpenses - cashIpApprovedExpenses;
  const oooSince = i.oooOpeningDate;
  const cashOooOpening = i.oooOpeningKopeks || 0;
  const cashOooOfdSinceOpening = ofdNet(i.ofdRows, "ooo", (d) => after(d, oooSince));
  const cashOooOfdYesterday = ofdNet(i.ofdRows, "ooo", (d) => d === i.yesterday);
  const cashOooOfdToday = ofdNet(i.ofdRows, "ooo", (d) => d === i.today);
  const cashOooOfdMonth = ofdNet(i.ofdRows, "ooo", (d) => d.startsWith(i.monthPrefix));
  const oooCol = i.collections.filter((c) => after(c.date, oooSince));
  const oooWd = i.withdrawals.filter((w) => after(w.date, oooSince));
  const cashOooPendingCollections = sum(pick(oooCol, [COLLECTION_STATUS.PENDING]));
  const cashOooApprovedCollections = sum(pick(oooCol, [COLLECTION_STATUS.APPROVED]));
  const cashOooPendingWithdrawalsToIp = sum(pick(oooWd, [WITHDRAWAL_STATUS.PENDING]));
  const cashOooApprovedWithdrawalsToIp = sum(pick(oooWd, [WITHDRAWAL_STATUS.APPROVED]));
  const cashOooFactBalance = cashOooOpening + cashOooOfdSinceOpening - cashOooPendingCollections - cashOooApprovedCollections - cashOooPendingWithdrawalsToIp - cashOooApprovedWithdrawalsToIp;
  return { cashIpOpening, cashIpOpeningSet: ipSince !== null, cashIpOfdSinceOpening, cashIpOfdYesterday, cashIpOfdToday, cashIpOfdMonth, cashIpWithdrawalsFromOoo, cashIpOtherIncome, cashIpPendingExpenses, cashIpApprovedExpenses, cashIpFactBalance, cashOooOpening, cashOooOpeningSet: oooSince !== null, cashOooOfdSinceOpening, cashOooOfdYesterday, cashOooOfdToday, cashOooOfdMonth, cashOooPendingCollections, cashOooApprovedCollections, cashOooPendingWithdrawalsToIp, cashOooApprovedWithdrawalsToIp, cashOooFactBalance };
}
const base = { oooOpeningKopeks: 0, ipOpeningKopeks: 0, oooOpeningDate: null, ipOpeningDate: null, ofdRows: [], today: "2026-07-18", yesterday: "2026-07-17", monthPrefix: "2026-07", collections: [], withdrawals: [], ipExpenses: [], ipOtherIncome: [] };

// Mirror loader: query DB rows for a club and run calc (single source of truth).
async function loadClubCash(companyId, clubId, now) {
  const typeById = new Map([[OOO, "ooo"], [IP, "ip"]]);
  const [snaps, ofd, collections, withdrawals, ipExpenses, other] = await Promise.all([
    p.balanceSnapshot.findMany({ where: { clubId, legalEntityId: { in: [OOO, IP] } }, orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }], select: { legalEntityId: true, actualBalanceKopeks: true, snapshotDate: true } }),
    p.ofdDailySalesSummary.findMany({ where: { companyId, clubId, provider: "taxcom" }, select: { legalEntityId: true, date: true, incomeCashKopeks: true, returnCashKopeks: true } }),
    p.cashCollection.findMany({ where: { clubId }, select: { status: true, amountKopeks: true, operationDate: true } }),
    p.cashWithdrawal.findMany({ where: { clubId }, select: { status: true, amountKopeks: true, operationDate: true } }),
    p.expense.findMany({ where: { clubId, legalEntityId: IP, paymentMethod: "cash", entryVersion: 2 }, select: { status: true, amountKopeks: true, expenseDate: true } }),
    p.cashMovement.findMany({ where: { clubId, legalEntityId: IP, type: "other_cash_income", status: "confirmed" }, select: { amountKopeks: true, occurredAt: true } }).catch(() => []),
  ]);
  const openBy = new Map();
  for (const s of snaps) if (!openBy.has(s.legalEntityId)) openBy.set(s.legalEntityId, { amount: s.actualBalanceKopeks, date: ymd(s.snapshotDate) });
  const oooOpen = openBy.get(OOO) ?? null, ipOpen = openBy.get(IP) ?? null;
  return calc({
    oooOpeningKopeks: oooOpen?.amount ?? 0, ipOpeningKopeks: ipOpen?.amount ?? 0, oooOpeningDate: oooOpen?.date ?? null, ipOpeningDate: ipOpen?.date ?? null,
    ofdRows: ofd.map((r) => ({ legalEntityType: r.legalEntityId ? typeById.get(r.legalEntityId) ?? null : null, date: r.date, incomeCashKopeks: r.incomeCashKopeks, returnCashKopeks: r.returnCashKopeks })),
    today: ymd(now), yesterday: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)), monthPrefix: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    collections: collections.map((c) => ({ status: c.status, amountKopeks: c.amountKopeks, date: ymd(c.operationDate) })),
    withdrawals: withdrawals.map((w) => ({ status: w.status, amountKopeks: w.amountKopeks, date: ymd(w.operationDate) })),
    ipExpenses: ipExpenses.map((e) => ({ status: e.status, amountKopeks: e.amountKopeks, date: ymd(e.expenseDate) })),
    ipOtherIncome: other.map((o) => ({ amountKopeks: o.amountKopeks, date: ymd(o.occurredAt) })),
  });
}

async function main() {
  await cleanup();
  await p.user.create({ data: { id: U, email: "cash@pilot.test", name: "Cash", role: "manager", isActive: true } });
  await p.company.create({ data: { id: CO, name: "Cash Co" } });
  await p.club.create({ data: { id: CLUB, name: "Cash Club", city: "X", companyId: CO } });
  await p.legalEntity.create({ data: { id: OOO, companyId: CO, type: "ooo", name: "ООО Кэш", isActive: true } });
  await p.legalEntity.create({ data: { id: IP, companyId: CO, type: "ip", name: "ИП Кэш", isActive: true } });
  await p.clubLegalEntity.create({ data: { clubId: CLUB, legalEntityId: OOO, isActive: true, isPrimary: true } });
  await p.clubLegalEntity.create({ data: { clubId: CLUB, legalEntityId: IP, isActive: true, isPrimary: true } });

  // ===== Pure calc: split + statuses =========================================
  const ofdRows = [
    { legalEntityType: "ooo", date: "2026-07-17", incomeCashKopeks: 300000, returnCashKopeks: 0 },
    { legalEntityType: "ip", date: "2026-07-17", incomeCashKopeks: 150000, returnCashKopeks: 50000 },
    { legalEntityType: "ip", date: "2026-07-10", incomeCashKopeks: 100000, returnCashKopeks: 0 },
  ];
  const r1 = calc({ ...base, ofdRows });
  check("CASH-SPLIT1 ОФД cash ИП counted separately from ООО", r1.cashOooOfdSinceOpening === 300000 && r1.cashIpOfdSinceOpening === 200000 && r1.cashOooOfdSinceOpening !== r1.cashIpOfdSinceOpening, `ooo=${r1.cashOooOfdSinceOpening} ip=${r1.cashIpOfdSinceOpening}`);
  check("CASH-SPLIT2 приход ИП вчера = OFD cash по ИП за yesterday (net of returns)", r1.cashIpOfdYesterday === 100000, `ip_yday=${r1.cashIpOfdYesterday}`);
  check("CASH-SPLIT3 приход ООО вчера = OFD cash по ООО за yesterday", r1.cashOooOfdYesterday === 300000, `ooo_yday=${r1.cashOooOfdYesterday}`);

  const rPend = calc({ ...base, ipExpenses: [{ status: "pending_accountant_verification", amountKopeks: 40000, date: "2026-07-18" }] });
  check("CASH-IP1 pending ИП-расход сразу уменьшает фактический остаток ИП", rPend.cashIpFactBalance === -40000 && rPend.cashIpPendingExpenses === 40000);
  const rRej = calc({ ...base, ipExpenses: [{ status: "cancelled", amountKopeks: 40000, date: "2026-07-18" }, { status: "rejected", amountKopeks: 10000, date: "2026-07-18" }] });
  check("CASH-IP2 отклонённый/отменённый ИП-расход не уменьшает остаток", rRej.cashIpFactBalance === 0 && rRej.cashIpPendingExpenses === 0 && rRej.cashIpApprovedExpenses === 0);
  const rDraft = calc({ ...base, ipExpenses: [{ status: "draft", amountKopeks: 99999, date: "2026-07-18" }] });
  check("CASH-IP3 черновик ИП-расхода не уменьшает остаток", rDraft.cashIpFactBalance === 0);
  const rMix = calc({ ...base, ipExpenses: [{ status: "pending_accountant_verification", amountKopeks: 40000, date: "2026-07-18" }, { status: "verified", amountKopeks: 25000, date: "2026-07-18" }] });
  check("CASH-IP4 аналитика: approved считает только verified/confirmed, pending отдельно (без двойного счёта)", rMix.cashIpApprovedExpenses === 25000 && rMix.cashIpPendingExpenses === 40000 && rMix.cashIpFactBalance === -65000);

  // ===== Pure calc: collections + withdrawals ================================
  const rColP = calc({ ...base, oooOpeningKopeks: 500000, collections: [{ status: COLLECTION_STATUS.PENDING, amountKopeks: 200000, date: "2026-07-18" }] });
  check("COLLECTION2 инкассация pending сразу уменьшает фактический остаток ООО", rColP.cashOooFactBalance === 300000 && rColP.cashOooPendingCollections === 200000);
  const rColR = calc({ ...base, oooOpeningKopeks: 500000, collections: [{ status: COLLECTION_STATUS.REJECTED, amountKopeks: 200000, date: "2026-07-18" }, { status: COLLECTION_STATUS.CANCELLED, amountKopeks: 100000, date: "2026-07-18" }] });
  check("COLLECTION3 отклонённая/отменённая инкассация возвращает сумму в остаток ООО", rColR.cashOooFactBalance === 500000 && rColR.cashOooPendingCollections === 0 && rColR.cashOooApprovedCollections === 0);
  const rColA = calc({ ...base, oooOpeningKopeks: 500000, collections: [{ status: COLLECTION_STATUS.APPROVED, amountKopeks: 200000, date: "2026-07-18" }] });
  check("COLLECTION-VIEW2 подтверждение инкассации не меняет остаток второй раз (pending→approved = один вычет)", rColA.cashOooFactBalance === 300000 && rColA.cashOooFactBalance === rColP.cashOooFactBalance);
  check("COLLECTION4 инкассация уменьшает только ООО (ИП не затрагивается)", rColP.cashIpFactBalance === 0);

  const rW = calc({ ...base, oooOpeningKopeks: 500000, ipOpeningKopeks: 100000, withdrawals: [{ status: WITHDRAWAL_STATUS.PENDING, amountKopeks: 120000, date: "2026-07-18" }] });
  check("WITHDRAWAL3 изъятие pending сразу уменьшает ООО и увеличивает ИП", rW.cashOooFactBalance === 380000 && rW.cashIpFactBalance === 220000 && rW.cashIpWithdrawalsFromOoo === 120000);
  const rWa = calc({ ...base, oooOpeningKopeks: 500000, ipOpeningKopeks: 100000, withdrawals: [{ status: WITHDRAWAL_STATUS.APPROVED, amountKopeks: 120000, date: "2026-07-18" }] });
  check("WITHDRAWAL4 подтверждение изъятия не меняет остатки второй раз", rWa.cashOooFactBalance === 380000 && rWa.cashIpFactBalance === 220000);
  const rWr = calc({ ...base, oooOpeningKopeks: 500000, ipOpeningKopeks: 100000, withdrawals: [{ status: WITHDRAWAL_STATUS.REJECTED, amountKopeks: 120000, date: "2026-07-18" }] });
  check("WITHDRAWAL5 отклонение/отмена изъятия откатывает: ООО назад вверх, ИП назад вниз", rWr.cashOooFactBalance === 500000 && rWr.cashIpFactBalance === 100000 && rWr.cashIpWithdrawalsFromOoo === 0);

  // ===== Opening checkpoint windowing ========================================
  const ofdWin = [
    { legalEntityType: "ooo", date: "2026-07-10", incomeCashKopeks: 100000, returnCashKopeks: 0 }, // before checkpoint
    { legalEntityType: "ooo", date: "2026-07-16", incomeCashKopeks: 200000, returnCashKopeks: 0 }, // after checkpoint
  ];
  const rWin = calc({ ...base, oooOpeningKopeks: 500000, oooOpeningDate: "2026-07-15", ofdRows: ofdWin });
  check("OPENING3 фактический остаток считается от контрольной точки, а не от начала месяца", rWin.cashOooOfdSinceOpening === 200000 && rWin.cashOooOfdMonth === 300000 && rWin.cashOooOfdSinceOpening !== rWin.cashOooOfdMonth);
  check("OPENING4 движения ДО даты контрольной точки не влияют на фактический остаток", rWin.cashOooFactBalance === 500000 + 200000);
  const rWinCol = calc({ ...base, oooOpeningKopeks: 500000, oooOpeningDate: "2026-07-15", collections: [{ status: "pending_accountant_review", amountKopeks: 100000, date: "2026-07-10" }, { status: "pending_accountant_review", amountKopeks: 50000, date: "2026-07-16" }] });
  check("OPENING5 движения ПОСЛЕ даты контрольной точки влияют (инкассация до T игнорируется)", rWinCol.cashOooPendingCollections === 50000 && rWinCol.cashOooFactBalance === 500000 - 50000);
  check("OPENING-flag opening flags reflect whether a checkpoint is set", rWin.cashOooOpeningSet === true && r1.cashOooOpeningSet === false && r1.cashIpOpeningSet === false);

  const rWV = calc({ ...base, oooOpeningKopeks: 500000, ipOpeningKopeks: 100000, oooOpeningDate: "2026-07-15", ipOpeningDate: "2026-07-15", withdrawals: [{ status: "pending_review", amountKopeks: 120000, date: "2026-07-16" }], ipOtherIncome: [{ amountKopeks: 7000, date: "2026-07-16" }] });
  check("WITHDRAWAL-VIEW1 «Изъятия из ООО» — отдельный показатель, не смешивается с «Приход Иное»", rWV.cashIpWithdrawalsFromOoo === 120000 && rWV.cashIpOtherIncome === 7000 && rWV.cashIpWithdrawalsFromOoo !== rWV.cashIpOtherIncome);
  check("WITHDRAWAL-VIEW2 изъятие увеличивает ИП и уменьшает ООО в фактическом остатке", rWV.cashIpFactBalance === 100000 + 120000 + 7000 && rWV.cashOooFactBalance === 500000 - 120000);
  check("LABELS1 расчёт различает вчера/сегодня/после-контрольной/за-месяц/факт (отдельные числовые поля)", ["cashIpOfdYesterday", "cashIpOfdToday", "cashIpOfdSinceOpening", "cashIpOfdMonth", "cashIpFactBalance", "cashOooOfdYesterday", "cashOooOfdToday", "cashOooOfdSinceOpening", "cashOooOfdMonth", "cashOooFactBalance"].every((k) => typeof rWV[k] === "number"));

  // ===== DB round-trips (no checkpoint yet → opening 0) =======================
  const now = new Date(2026, 6, 18); // 2026-07-18
  const mkSummary = (legal, date, cash) => p.ofdDailySalesSummary.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: legal, provider: "taxcom", date, summaryKey: `${CO}:${CLUB}:${legal}:taxcom:${date}`, incomeTotalKopeks: cash, incomeCashKopeks: cash, incomeElectronicKopeks: 0, returnTotalKopeks: 0, returnCashKopeks: 0, returnElectronicKopeks: 0, netTotalKopeks: cash, receiptCount: 1, returnReceiptCount: 0 } });
  await mkSummary(OOO, "2026-07-17", 300000);
  await mkSummary(IP, "2026-07-17", 150000);
  const dbSplit = await loadClubCash(CO, CLUB, now);
  check("CASH-SPLIT-DB OFD summaries split ООО/ИП cash from OfdDailySalesSummary by legalEntityId", dbSplit.cashOooOfdSinceOpening === 300000 && dbSplit.cashIpOfdSinceOpening === 150000 && dbSplit.cashOooOfdYesterday === 300000 && dbSplit.cashIpOfdYesterday === 150000);

  const col = await p.cashCollection.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: OOO, amountKopeks: 200000, operationDate: now, status: "pending_accountant_review", createdByUserId: U } });
  await p.cashOperationDocument.create({ data: { collectionId: col.id, companyId: CO, clubId: CLUB, storageKey: `cash-docs/${"a".repeat(64)}.pdf`, originalFilename: "act.pdf", safeFilename: "act.pdf", mimeType: "application/pdf", sizeBytes: 100, sha256: "x", uploadedByUserId: U } });
  check("COLLECTION1 инкассация ООО создаётся (сумма/дата/статус pending) с документом", col.status === "pending_accountant_review" && col.legalEntityId === OOO && (await p.cashOperationDocument.count({ where: { collectionId: col.id } })) === 1);
  const afterCol = await loadClubCash(CO, CLUB, now);
  check("COLLECTION-VIEW1 инкассация pending уменьшает фактический остаток ООО (через модель)", afterCol.cashOooPendingCollections === 200000 && afterCol.cashOooFactBalance === 300000 - 200000);
  const okApprove = await p.cashCollection.updateMany({ where: { id: col.id, status: "pending_accountant_review" }, data: { status: "approved", reviewedByUserId: U, reviewedAt: now } });
  check("COLLECTION5 бухгалтер подтверждает инкассацию (pending→approved, идемпотентно)", okApprove.count === 1 && (await p.cashCollection.updateMany({ where: { id: col.id, status: "pending_accountant_review" }, data: { status: "approved" } })).count === 0);
  check("COLLECTION-VIEW2-DB approved не меняет остаток ООО второй раз", (await loadClubCash(CO, CLUB, now)).cashOooFactBalance === afterCol.cashOooFactBalance);
  await p.cashCollection.updateMany({ where: { id: col.id }, data: { status: "rejected" } });
  check("COLLECTION-VIEW3 отклонение инкассации возвращает остаток ООО", (await loadClubCash(CO, CLUB, now)).cashOooFactBalance === 300000);

  const wd = await p.cashWithdrawal.create({ data: { companyId: CO, clubId: CLUB, fromLegalEntityId: OOO, toLegalEntityId: IP, amountKopeks: 120000, operationDate: now, status: "pending_review", createdByUserId: U } });
  const afterWd = await loadClubCash(CO, CLUB, now);
  check("WITHDRAWAL-VIEW3-DB изъятие pending: ООО ↓ и ИП ↑ (через модель)", afterWd.cashOooFactBalance === 300000 - 120000 && afterWd.cashIpFactBalance === 150000 + 120000 && wd.fromLegalEntityId === OOO && wd.toLegalEntityId === IP);
  await p.cashWithdrawal.updateMany({ where: { id: wd.id }, data: { status: "rejected" } });
  const afterWdRej = await loadClubCash(CO, CLUB, now);
  check("WITHDRAWAL5-DB отклонение изъятия откатывает ООО и ИП", afterWdRej.cashOooFactBalance === 300000 && afterWdRej.cashIpFactBalance === 150000);
  check("WITHDRAWAL-VIEW3 изъятие не создаёт Sale, не попадает в ОФД-продажи/статьи доходов", (await p.sale.count({ where: { companyId: CO } }).catch(() => 0)) === 0 && (await p.ofdReceiptItem.count({ where: { companyId: CO } }).catch(() => 0)) === 0 && (await p.ofdReceiptImport.count({ where: { companyId: CO } }).catch(() => 0)) === 0);

  // ===== Opening checkpoint via BalanceSnapshot (DB) =========================
  await p.ofdDailySalesSummary.deleteMany({ where: { companyId: CO } });
  await p.cashCollection.deleteMany({ where: { companyId: CO } });
  await p.cashWithdrawal.deleteMany({ where: { companyId: CO } });
  await mkSummary(OOO, "2026-07-10", 100000); // before checkpoint
  await mkSummary(OOO, "2026-07-16", 200000); // after checkpoint
  await p.balanceSnapshot.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: OOO, snapshotDate: new Date(2026, 6, 15), actualBalanceKopeks: 500000, comment: "пересчёт кассы ООО", createdById: U } });
  await p.balanceSnapshot.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: IP, snapshotDate: new Date(2026, 6, 15), actualBalanceKopeks: 100000, comment: "пересчёт кассы ИП", createdById: U } });
  check("OPENING1 контрольный остаток ООО задаётся отдельно (snapshot по legalEntityId ООО)", (await p.balanceSnapshot.count({ where: { clubId: CLUB, legalEntityId: OOO } })) === 1);
  check("OPENING2 контрольный остаток ИП задаётся отдельно (snapshot по legalEntityId ИП)", (await p.balanceSnapshot.count({ where: { clubId: CLUB, legalEntityId: IP } })) === 1);
  const dbOpen = await loadClubCash(CO, CLUB, now);
  check("OPENING3-DB фактический остаток от последней контрольной точки (движения до T игнорируются)", dbOpen.cashOooOpening === 500000 && dbOpen.cashOooOpeningSet === true && dbOpen.cashOooOfdSinceOpening === 200000 && dbOpen.cashOooOfdMonth === 300000 && dbOpen.cashOooFactBalance === 700000);
  const snaps = await p.balanceSnapshot.findMany({ where: { clubId: CLUB }, orderBy: { snapshotDate: "desc" } });
  check("OPENING6 история контрольных остатков хранит дату/сумму/комментарий/автора", snaps.length === 2 && snaps.every((s) => s.snapshotDate && typeof s.actualBalanceKopeks === "number" && s.comment && s.createdById === U));
  // A NEWER checkpoint supersedes the older one and re-bases the balance.
  await p.balanceSnapshot.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: OOO, snapshotDate: new Date(2026, 6, 17), actualBalanceKopeks: 900000, comment: "новая контрольная точка", createdById: U } });
  const dbOpen2 = await loadClubCash(CO, CLUB, now);
  check("OPENING-supersede последняя контрольная точка (по дате) используется как база; ОФД до неё игнорируется", dbOpen2.cashOooOpening === 900000 && dbOpen2.cashOooOfdSinceOpening === 0 && dbOpen2.cashOooFactBalance === 900000);

  // ===== Static source guards ================================================
  const rd = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const lib = rd("src/lib/cash-balances.ts");
  const loader = rd("src/lib/cash-collections.ts");
  const actions = rd("src/app/(app)/collections/actions.ts");
  const pageSrc = rd("src/app/(app)/collections/page.tsx");
  const forms = rd("src/app/(app)/collections/_components/CollectionForms.tsx");
  const authSrc = rd("src/lib/auth.ts");
  const dashSrc = rd("src/app/(app)/dashboard/_components/CashScopeSummary.tsx");
  const wsSrc = rd("src/app/(app)/workspace/page.tsx");
  const docStore = rd("src/lib/cash-document-storage.ts");
  const expSrc = rd("src/app/(app)/expenses/page.tsx");

  check("BALANCE-ALIGN1 collections + expenses + dashboard use the SAME loadClubCashBalances (single source)", pageSrc.includes("loadClubCashBalances") && expSrc.includes("loadClubCashBalances") && dashSrc.includes("loadClubCashBalances") && loader.includes("calculateCashBalances"));
  check("BALANCE-ALIGN2 expenses page no longer renders the conflicting wallet cards (getClubCashCards removed)", !expSrc.includes("getClubCashCards") && !expSrc.includes("Всего наличных ИП") && expSrc.includes("IpCashFactBlock"));
  check("DASHBOARD-CASH-ALIGN1 dashboard cash cards come from loadClubCashBalances (same fact balance as /collections)", dashSrc.includes("loadClubCashBalances") && dashSrc.includes("cashOooFactBalance") && dashSrc.includes("cashIpFactBalance"));
  check("LABELS-S UI distinguishes вчера / сегодня / после контрольной точки / за месяц / фактический остаток", pageSrc.includes("вчера") && pageSrc.includes("сегодня") && pageSrc.includes("после контрольной точки") && pageSrc.includes("за месяц") && (pageSrc.includes("Фактический остаток") || pageSrc.includes("Расчётный остаток")));
  check("WITHDRAWAL-VIEW-S UI shows «Изъятия из ООО» separate from «Приход «Иное»» (not merged)", pageSrc.includes("Изъятия из ООО") && pageSrc.includes("Приход «Иное»") && expSrc.includes("Изъятия из ООО") && !/Иное[\s\S]{0,40}Изъяти|Изъяти[\s\S]{0,40}Приход «Иное»/.test(pageSrc.replace(/\n/g, " ")));
  check("OPENING7 без комментария контрольный остаток создать нельзя (comment обязателен)", actions.includes("Комментарий обязателен") && /if \(!comment\)/.test(actions));
  check("OPENING-S setCashOpeningBalance создаёт НОВУЮ контрольную точку (balanceSnapshot.create), не редактирует историю; аудит cash.opening_balance_set", actions.includes("export async function setCashOpeningBalance") && actions.includes("prisma.balanceSnapshot.create") && !/balanceSnapshot\.update/.test(actions) && actions.includes('"cash.opening_balance_set"'));
  check("ROLE-OPENING1/2 контрольный остаток скоупится по allowedClubIds (manager/regional только свои клубы)", actions.includes("ctx.allowedClubIds.includes(clubId)") && actions.includes("canSetOpeningBalance(g.roles)"));
  check("SYNC-CASH1 sync ИП uses runSyncNowForCompany, returns SAFE summary (found/imported/skipped), no secrets", actions.includes("export async function syncIpCashAction") && actions.includes("runSyncNowForCompany") && /found:\s*t\.foundReceipts/.test(actions) && !/login|password|integratorId|sessionToken|Bearer/i.test(actions));
  check("SYNC-CASH2 sync ООО uses the same safe sync path; hint mentions вчера/период/фактический (not only «за сегодня»)", actions.includes("export async function syncOooCashAction") && pageSrc.includes("пересчитываются вчера, период и фактический остаток"));
  check("COLLECTION6 create requires >=1 document (min) — server-enforced", docStore.includes("MIN_CASH_OPERATION_DOCUMENTS = 1") && actions.includes("Прикрепите хотя бы один подтверждающий документ") && /files\.length < MIN_CASH_OPERATION_DOCUMENTS/.test(actions));
  check("COLLECTION7 create rejects >3 documents (max)", docStore.includes("MAX_CASH_OPERATION_DOCUMENTS = 3") && /files\.length > MAX_CASH_OPERATION_DOCUMENTS/.test(actions));
  check("WITHDRAWAL1/2 create gated to canCreateOperational (manager + regional_director have operational.create)", /regional_director:\s*\["operational\.create"\]/.test(authSrc) && /manager:\s*\["operational\.create"\]/.test(authSrc) && actions.includes("canCreateOperational(g.roles)") && actions.includes("export async function createCashWithdrawal"));
  check("ROLE-CASH page access owner/GD/regional/manager/accountant/chief (NOT marketer); page guarded", /owner:\s*\[[^\]]*"collections"/.test(authSrc) && /regional_director:\s*\[[^\]]*"collections"/.test(authSrc) && /\bmanager:\s*\[[^\]]*"collections"/.test(authSrc) && /\baccountant:\s*\[[^\]]*"collections"/.test(authSrc) && !/marketer:\s*\[[^\]]*"collections"/.test(authSrc) && pageSrc.includes('requirePageAccess("collections")'));
  check("ROLE-CASH1 pages scope to allowedClubIds (manager only own clubs)", pageSrc.includes("ctx.allowedClubIds") && actions.includes("ctx.allowedClubIds.includes(clubId)"));
  check("DASHBOARD-CASH1 dashboard cash cards: ООО/ИП + pending counters gated by financials", dashSrc.includes("Наличные ООО") && dashSrc.includes("Наличные ИП") && dashSrc.includes("Инкассации на проверке") && dashSrc.includes("Изъятия на проверке") && dashSrc.includes("showPending") && rd("src/app/(app)/dashboard/page.tsx").includes("showPending={financials}"));
  check("DASHBOARD-CASH2 manager sees operational balances w/o review counters (showPending gate)", /showPending \? [\s\S]{0,200}Инкассации на проверке/.test(dashSrc) && dashSrc.includes("showPending ? "));
  check("ROLE-CASH2 accountant workspace surfaces инкассации/изъятия на проверке", wsSrc.includes("Инкассации на проверке") && wsSrc.includes("Изъятия на проверке") && wsSrc.includes("loadPendingCashOps"));
  check("SECURITY no secrets/technical fiscal terms/PII in cash page, forms, actions, lib, loader, dashboard", ![pageSrc, forms, actions, lib, loader, dashSrc].some((s) => /login|password|integratorId|sessionToken|Bearer|rawJson|fiscalSign|ФПД|ShiftList|DocumentInfo|NewDocuments|\bphone\b|\bemail\b|buyer|customer|\.stack/i.test(s)));
  check("SECURITY-audit cash audit actions are cash.* with SAFE metadata (amountKopeks/counts), never raw/PII", actions.includes('"cash.collection_created"') && actions.includes('"cash.withdrawal_created"') && actions.includes('"cash.opening_balance_set"') && actions.includes("metadata: { amountKopeks") && !/metadata:\s*\{[^}]*(rawJson|fiscalSign|\bphone\b|\bemail\b|\.stack)/i.test(actions));
  check("NO-MIX withdrawal/collection are NOT sales/income: no Sale/Ofd writes in actions", !/prisma\.sale\.create|ofdReceipt|ofdDailySalesSummary\.create|ofdRevenueCategory/i.test(actions));
  check("MIGRATION dev+prod add CashCollection/CashWithdrawal/CashOperationDocument (non-destructive CREATE TABLE)", /CREATE TABLE "CashCollection"/.test(rd("prisma/migrations/20260718000000_add_cash_collections_withdrawals/migration.sql")) && /CREATE TABLE "CashWithdrawal"/.test(rd("prisma/production/migrations/20260718000000_add_cash_collections_withdrawals/migration.sql")) && /CREATE TABLE "CashOperationDocument"/.test(rd("prisma/production/migrations/20260718000000_add_cash_collections_withdrawals/migration.sql")));
  check("LIB pure calc exports calculateCashBalances + opening-window fields; no I/O", lib.includes("export function calculateCashBalances") && lib.includes("cashOooOfdSinceOpening") && lib.includes("cashOooOpeningSet") && lib.includes("oooOpeningDate") && !lib.includes("import { prisma }"));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
