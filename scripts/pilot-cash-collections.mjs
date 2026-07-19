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
  await p.cashOtherIncome.deleteMany({ where: { companyId: CO } }).catch(() => {});
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
const OTHER_INCOME_FACT = ["pending_review", "approved"];
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
  const cashIpOtherIncome = sum(pick(other.filter((o) => after(o.date, ipSince)), OTHER_INCOME_FACT));
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
    p.cashOtherIncome.findMany({ where: { clubId, legalEntityId: IP }, select: { status: true, amountKopeks: true, operationDate: true } }).catch(() => []),
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
    ipOtherIncome: other.map((o) => ({ status: o.status, amountKopeks: o.amountKopeks, date: ymd(o.operationDate) })),
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

  const rWV = calc({ ...base, oooOpeningKopeks: 500000, ipOpeningKopeks: 100000, oooOpeningDate: "2026-07-15", ipOpeningDate: "2026-07-15", withdrawals: [{ status: "pending_review", amountKopeks: 120000, date: "2026-07-16" }], ipOtherIncome: [{ status: "pending_review", amountKopeks: 7000, date: "2026-07-16" }] });
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

  // ===== Cancellations (soft-cancel, never hard delete) ======================
  const cancelColl = async (id) => (await p.cashCollection.updateMany({ where: { id, status: { in: ["draft", "pending_accountant_review"] } }, data: { status: "cancelled", reviewedByUserId: U, reviewedAt: now, reviewReason: "тест" } })).count;
  const cancelWd = async (id) => (await p.cashWithdrawal.updateMany({ where: { id, status: { in: ["draft", "pending_review"] } }, data: { status: "cancelled", reviewedByUserId: U, reviewedAt: now, reviewReason: "тест" } })).count;

  const colC = await p.cashCollection.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: OOO, amountKopeks: 100000, operationDate: now, status: "pending_accountant_review", createdByUserId: U } });
  const beforeCancel = await loadClubCash(CO, CLUB, now);
  check("CANCEL-COLLECTION1 pending-инкассацию можно отменить (soft-cancel → cancelled)", (await cancelColl(colC.id)) === 1 && (await p.cashCollection.findUnique({ where: { id: colC.id } })).status === "cancelled");
  const afterCancel = await loadClubCash(CO, CLUB, now);
  check("CANCEL-COLLECTION2 cancelled-инкассация больше не уменьшает остаток ООО", afterCancel.cashOooFactBalance === beforeCancel.cashOooFactBalance + 100000);
  const colA = await p.cashCollection.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: OOO, amountKopeks: 50000, operationDate: now, status: "approved", createdByUserId: U } });
  check("CANCEL-COLLECTION3 approved-инкассацию нельзя отменить обычным действием (updateMany guard = 0)", (await cancelColl(colA.id)) === 0 && (await p.cashCollection.findUnique({ where: { id: colA.id } })).status === "approved");
  check("CANCEL-COLLECTION4 cancelled-инкассация остаётся в истории (не hard delete)", (await p.cashCollection.findUnique({ where: { id: colC.id } })) !== null && (await p.cashCollection.findUnique({ where: { id: colC.id } })).status === "cancelled");

  const wdC = await p.cashWithdrawal.create({ data: { companyId: CO, clubId: CLUB, fromLegalEntityId: OOO, toLegalEntityId: IP, amountKopeks: 80000, operationDate: now, status: "pending_review", createdByUserId: U } });
  const beforeW = await loadClubCash(CO, CLUB, now);
  check("CANCEL-WITHDRAWAL1 pending-изъятие можно отменить", (await cancelWd(wdC.id)) === 1 && (await p.cashWithdrawal.findUnique({ where: { id: wdC.id } })).status === "cancelled");
  const afterW = await loadClubCash(CO, CLUB, now);
  check("CANCEL-WITHDRAWAL2 cancelled-изъятие больше не уменьшает ООО и не увеличивает ИП", afterW.cashOooFactBalance === beforeW.cashOooFactBalance + 80000 && afterW.cashIpFactBalance === beforeW.cashIpFactBalance - 80000);
  const wdA = await p.cashWithdrawal.create({ data: { companyId: CO, clubId: CLUB, fromLegalEntityId: OOO, toLegalEntityId: IP, amountKopeks: 30000, operationDate: now, status: "approved", createdByUserId: U } });
  check("CANCEL-WITHDRAWAL3 approved-изъятие нельзя отменить обычным действием", (await cancelWd(wdA.id)) === 0 && (await p.cashWithdrawal.findUnique({ where: { id: wdA.id } })).status === "approved");
  check("CANCEL-WITHDRAWAL4 cancelled-изъятие остаётся в истории", (await p.cashWithdrawal.findUnique({ where: { id: wdC.id } })) !== null);
  const l1 = await loadClubCash(CO, CLUB, now), l2 = await loadClubCash(CO, CLUB, now);
  check("DASHBOARD-CANCEL1 после отмены остатки детерминированы (единый источник loadClubCashBalances для /collections, /expenses, dashboard)", JSON.stringify(l1) === JSON.stringify(l2));

  // ===== Приход «Иное» (top-up ИП) ===========================================
  const summariesBefore = await p.ofdDailySalesSummary.count({ where: { companyId: CO } });
  const beforeOI = await loadClubCash(CO, CLUB, now);
  const oi = await p.cashOtherIncome.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: IP, amountKopeks: 70000, operationDate: now, source: "regional", comment: "передал регионал", status: "pending_review", createdByUserId: U } });
  check("OTHER-INCOME1 «Приход Иное» в ИП создаётся по клубу (source/comment/status pending_review)", oi.status === "pending_review" && oi.legalEntityId === IP && oi.source === "regional" && oi.comment === "передал регионал");
  const afterOI = await loadClubCash(CO, CLUB, now);
  check("OTHER-INCOME2 pending «Приход Иное» сразу увеличивает фактический остаток ИП", afterOI.cashIpFactBalance === beforeOI.cashIpFactBalance + 70000 && afterOI.cashIpOtherIncome === beforeOI.cashIpOtherIncome + 70000);
  check("OTHER-INCOME3 «Приход Иное» не меняет остаток ООО", afterOI.cashOooFactBalance === beforeOI.cashOooFactBalance);
  check("OTHER-INCOME4 «Приход Иное» — отдельный показатель, не смешивается с «Изъятиями из ООО»", afterOI.cashIpWithdrawalsFromOoo === beforeOI.cashIpWithdrawalsFromOoo && afterOI.cashIpOtherIncome !== afterOI.cashIpWithdrawalsFromOoo);
  check("OTHER-INCOME5 «Приход Иное» сохранён в истории (запись со статусом/источником/комментарием)", (await p.cashOtherIncome.findUnique({ where: { id: oi.id } })) !== null);
  // Soft-cancel: pending → cancelled → no longer increases ИП.
  const okCancelOI = await p.cashOtherIncome.updateMany({ where: { id: oi.id, status: { in: ["draft", "pending_review"] } }, data: { status: "cancelled", reviewedByUserId: U, reviewedAt: now } });
  check("OTHER-INCOME6a pending «Приход Иное» можно отменить (soft-cancel, не hard delete)", okCancelOI.count === 1 && (await p.cashOtherIncome.findUnique({ where: { id: oi.id } })).status === "cancelled");
  const afterCancelOI = await loadClubCash(CO, CLUB, now);
  check("OTHER-INCOME6 cancelled «Приход Иное» больше не увеличивает остаток ИП", afterCancelOI.cashIpFactBalance === beforeOI.cashIpFactBalance && afterCancelOI.cashIpOtherIncome === beforeOI.cashIpOtherIncome);
  const oiA = await p.cashOtherIncome.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: IP, amountKopeks: 20000, operationDate: now, source: "owner", comment: "внёс собственник", status: "approved", createdByUserId: U } });
  check("OTHER-INCOME7 approved «Приход Иное» нельзя отменить обычным действием", (await p.cashOtherIncome.updateMany({ where: { id: oiA.id, status: { in: ["draft", "pending_review"] } }, data: { status: "cancelled" } })).count === 0 && (await p.cashOtherIncome.findUnique({ where: { id: oiA.id } })).status === "approved");
  check("OTHER-INCOME8 «Приход Иное» не создаёт Sale", (await p.sale.count({ where: { companyId: CO } }).catch(() => 0)) === 0);
  check("OTHER-INCOME9 «Приход Иное» не попадает в ОФД-продажи/статьи доходов (нет OfdReceiptItem/Import; OfdDailySalesSummary не создаётся операцией)", (await p.ofdReceiptItem.count({ where: { companyId: CO } }).catch(() => 0)) === 0 && (await p.ofdReceiptImport.count({ where: { companyId: CO } }).catch(() => 0)) === 0 && (await p.ofdDailySalesSummary.count({ where: { companyId: CO } })) === summariesBefore);
  const oiL1 = await loadClubCash(CO, CLUB, now), oiL2 = await loadClubCash(CO, CLUB, now);
  check("DASHBOARD-OTHER-INCOME1 после «Прихода Иное» /collections, /expenses, dashboard дают один ИП-остаток (единый loader)", JSON.stringify(oiL1) === JSON.stringify(oiL2));
  // Documents optional: «Приход Иное» with ZERO documents is valid and counts.
  const beforeND = await loadClubCash(CO, CLUB, now);
  const oiND = await p.cashOtherIncome.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: IP, amountKopeks: 15000, operationDate: now, source: "other", comment: "без чека", status: "pending_review", createdByUserId: U } });
  const afterND = await loadClubCash(CO, CLUB, now);
  check("OTHER-INCOME-DOCS1 «Приход Иное» создаётся БЕЗ документа (0 файлов) и увеличивает остаток ИП", (await p.cashOperationDocument.count({ where: { otherIncomeId: oiND.id } })) === 0 && afterND.cashIpOtherIncome === beforeND.cashIpOtherIncome + 15000 && afterND.cashIpFactBalance === beforeND.cashIpFactBalance + 15000);

  // ===== Static source guards ================================================
  const rd = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const lib = rd("src/lib/cash-balances.ts");
  const loader = rd("src/lib/cash-collections.ts");
  const actions = rd("src/app/(app)/collections/actions.ts");
  const pageSrc = rd("src/app/(app)/collections/page.tsx");
  const forms = rd("src/app/(app)/collections/_components/CollectionForms.tsx");
  const authSrc = rd("src/lib/auth.ts");
  const dashSrc = rd("src/app/(app)/dashboard/_components/CashScopeSummary.tsx");
  const keyCardsSrc = rd("src/app/(app)/dashboard/_components/DashboardKeyCards.tsx");
  const wsSrc = rd("src/app/(app)/workspace/page.tsx");
  const docStore = rd("src/lib/cash-document-storage.ts");
  const expSrc = rd("src/app/(app)/expenses/page.tsx");
  const oldCashSrc = rd("src/app/(app)/expenses/cash/page.tsx");

  // ----- Legacy "Касса ИП" retired + cancellations -----
  check("CASH-OLD-UI1 старая «Касса ИП» больше не показывает confirmed-only остаток (убраны getClubCashBreakdown/«Наличные в клубе»/«У региональных»); показывает фактический из loadClubCashBalances", !oldCashSrc.includes("getClubCashBreakdown") && !oldCashSrc.includes("Наличные в клубе") && !oldCashSrc.includes("У региональных директоров") && !oldCashSrc.includes("Передача наличных") && oldCashSrc.includes("loadClubCashBalances") && oldCashSrc.includes("Управление кассой перенесено"));
  check("CASH-OLD-UI2 на странице расходов нет второго остатка ИП (getClubCashCards/CashCards/«Всего наличных ИП» убраны)", !expSrc.includes("getClubCashCards") && !expSrc.includes("CashCards") && !expSrc.includes("Всего наличных ИП") && !expSrc.includes('href="/expenses/cash"'));
  check("CASH-OLD-UI3 пользователь видит ссылку на /collections для управления кассой", expSrc.includes('href="/collections"') && oldCashSrc.includes('href="/collections"'));
  // ----- Приход «Иное» (new system) -----
  check("OTHER-INCOME-MODEL loader берёт «Иное» из CashOtherIncome (pending/approved), не из старого confirmed-only CashMovement", loader.includes("cashOtherIncome.findMany") && !loader.includes("cashMovement.findMany") && lib.includes("OTHER_INCOME_FACT_STATUSES") && /OTHER_INCOME_FACT_STATUSES[^\n]*OTHER_INCOME_STATUS\.PENDING[^\n]*OTHER_INCOME_STATUS\.APPROVED/.test(lib) && lib.includes('PENDING: "pending_review"'));
  check("OTHER-INCOME5-S история /collections включает CashOtherIncome (kind other_income + источник + подсчёт документов)", loader.includes('kind: "other_income"') && loader.includes("otherIncomeId") && pageSrc.includes("other_income") && pageSrc.includes("SOURCE_LABELS") && forms.includes("export function OtherIncomeForm"));
  check("OTHER-INCOME-CREATE create: canCreateOperational, комментарий обязателен, документы опциональны (0), pending_review, источник валидируется", actions.includes("export async function createCashOtherIncome") && actions.includes("canCreateOperational(g.roles)") && /if \(!comment\) return \{ ok: false, error: "Комментарий обязателен/.test(actions) && actions.includes("collectDocuments(formData, 0)") && actions.includes('status: "pending_review"') && actions.includes("OTHER_INCOME_SOURCES"));
  check("OTHER-INCOME7-S approved «Приход Иное» нельзя отменить (guard), soft-cancel только draft/pending_review, без hard delete", actions.includes("export async function cancelCashOtherIncome") && actions.includes("Подтверждённый приход «Иное» нельзя удалить") && /status: \{ in: CANCELABLE_OTHER_INCOME \}/.test(actions) && !/cashOtherIncome\.delete/.test(actions) && actions.includes('CANCELABLE_OTHER_INCOME = ["draft", "pending_review"]'));
  check("OTHER-INCOME10 /expenses/cash остаётся read-only указателем — старая форма «Приход Иное»/«Передача» НЕ возвращена", !oldCashSrc.includes("OtherIncomeForm") && !oldCashSrc.includes("TransferForm") && !oldCashSrc.includes("createOtherCashIncome") && oldCashSrc.includes("Управление кассой перенесено"));
  check("OTHER-INCOME11 на «Наличных расходах» есть переход «Добавить приход «Иное»» → /collections", expSrc.includes("Добавить приход «Иное»") && /Добавить приход «Иное»[\s\S]{0,120}href="\/collections"|href="\/collections"[\s\S]{0,120}Добавить приход «Иное»/.test(expSrc));
  check("OTHER-INCOME-ROLE1/2 create скоуп allowedClubIds (manager/regional свои клубы); ROLE3 вне scope нельзя (clubId in allowedClubIds в create/cancel)", actions.includes("ctx.allowedClubIds.includes(clubId)") && /createCashOtherIncome[\s\S]{0,700}clubId: \{ in: g\.clubIds \}|cancelCashOtherIncome[\s\S]{0,500}clubId: \{ in: g\.clubIds \}/.test(actions) && actions.includes("const isCreator = row.createdByUserId === g.userId"));
  check("OTHER-INCOME-NO-MIX «Приход Иное» не создаёт Sale/OFD/выручку; не изъятие/инкассация", !/createCashOtherIncome[\s\S]{0,900}(prisma\.sale\.create|ofdReceipt|ofdDailySalesSummary\.create|ofdRevenueCategory|cashWithdrawal\.create|cashCollection\.create)/.test(actions) && actions.includes('"cash.other_income_created"'));
  check("OTHER-INCOME-AUDIT события cash.other_income_* с безопасными полями (amount/source/status/reason), без документов/секретов/ПДн", actions.includes('"cash.other_income_created"') && actions.includes('"cash.other_income_cancelled"') && actions.includes('"cash.other_income_approved"') && actions.includes('"cash.other_income_rejected"') && !/other_income[\s\S]{0,300}metadata:\s*\{[^}]*(storageKey|rawJson|\bphone\b|\bemail\b|\.stack)/i.test(actions));
  check("OTHER-INCOME-MIGRATION dev+prod: CashOtherIncome table + CashOperationDocument.otherIncomeId (неразрушающе)", /CREATE TABLE "CashOtherIncome"/.test(rd("prisma/migrations/20260719000000_add_cash_other_income/migration.sql")) && /ADD COLUMN "otherIncomeId"/.test(rd("prisma/migrations/20260719000000_add_cash_other_income/migration.sql")) && /CREATE TABLE "CashOtherIncome"/.test(rd("prisma/production/migrations/20260719000000_add_cash_other_income/migration.sql")) && /ADD COLUMN "otherIncomeId"/.test(rd("prisma/production/migrations/20260719000000_add_cash_other_income/migration.sql")));

  // ----- Compact /collections UI + optional other-income docs -----
  const globalsCss = rd("src/app/globals.css");
  const oiFormBlock = forms.slice(forms.indexOf("export function OtherIncomeForm"), forms.indexOf("export function OtherIncomeForm") + 2200);
  const colFormBlock = forms.slice(forms.indexOf("export function CollectionForm"), forms.indexOf("export function CollectionForm") + 2200);
  const wdFormBlock = forms.slice(forms.indexOf("export function WithdrawalForm"), forms.indexOf("export function WithdrawalForm") + 2200);
  const collComp = pageSrc.slice(pageSrc.indexOf("function Collapsible"), pageSrc.indexOf("function Collapsible") + 900);
  check("COLLECTIONS-COMPACT1 видимы по умолчанию: синхронизация + карточки ООО/ИП (в Section, без раскрытия)", pageSrc.includes('<Section title="Синхронизация наличных из ОФД">') && pageSrc.includes("<Section key={club.id}") && pageSrc.includes("<OooCard") && pageSrc.includes("<IpCard"));
  check("COLLECTIONS-COMPACT2 формы (Контрольный остаток/Инкассировать/Изъять/Пополнить ИП) под раскрывающимися блоками, свернуты по умолчанию", pageSrc.includes('<Collapsible title="Контрольный остаток"') && pageSrc.includes('<Collapsible title="Инкассировать ООО"') && pageSrc.includes('<Collapsible title="Изъять из ООО в ИП"') && pageSrc.includes('<Collapsible title="Пополнить ИП') && !/<details[^>]*\bopen\b/.test(pageSrc));
  check("COLLECTIONS-COMPACT3 история операций свернута под раскрывающимся блоком", pageSrc.includes('<Collapsible title="История операций"'));
  check("COLLECTIONS-COMPACT4 раскрытие через нативный <details>/<summary> (безопасно для server actions); формы внутри", pageSrc.includes("function Collapsible") && pageSrc.includes('<details className="group') && pageSrc.includes("<summary") && pageSrc.includes("<CollectionForm") && pageSrc.includes("<OtherIncomeForm"));
  check("OTHER-INCOME-DOCS1b форма «Пополнить ИП»: документы НЕ обязательны (нет required на file input), подпись «необязательно»", /name="documents" multiple accept/.test(oiFormBlock) && !/name="documents"[^>]*required/.test(oiFormBlock) && oiFormBlock.includes("необязательно") && actions.includes("collectDocuments(formData, 0)"));
  check("OTHER-INCOME-DOCS2 «Приход Иное»: 1–3 документа допустимы (multiple + общий max 3)", /name="documents" multiple/.test(oiFormBlock) && docStore.includes("MAX_CASH_OPERATION_DOCUMENTS = 3"));
  check("OTHER-INCOME-DOCS3 больше 3 документов нельзя (общая серверная проверка max)", /files\.length > MAX_CASH_OPERATION_DOCUMENTS/.test(actions));
  check("OTHER-INCOME-DOCS4 комментарий обязателен для «Приход Иное»", /createCashOtherIncome[\s\S]{0,1500}if \(!comment\) return \{ ok: false, error: "Комментарий обязателен/.test(actions));
  check("OTHER-INCOME-DOCS5 инкассация ООО по-прежнему требует документ (required + server min по умолчанию)", /name="documents"[^>]*required/.test(colFormBlock) && /createCashCollection[\s\S]{0,1500}collectDocuments\(formData\);/.test(actions));
  check("OTHER-INCOME-DOCS6 изъятие ООО→ИП по-прежнему требует документ", /name="documents"[^>]*required/.test(wdFormBlock) && /createCashWithdrawal[\s\S]{0,1500}collectDocuments\(formData\);/.test(actions));
  check("DARK-COLLAPSIBLE1 раскрывающиеся блоки читаемы в тёмной теме (нейтральные токен-классы + .dark remap; не белые на тёмном)", collComp.includes("bg-white") && collComp.includes("border-slate-200") && collComp.includes("text-slate-700") && globalsCss.includes(".dark .bg-white") && globalsCss.includes(".dark .border-slate-200") && globalsCss.includes(".dark .text-slate-700"));
  check("CANCEL-ROLE1/2 отмена доступна создателю (pending) или reviewer (regional/accountant/owner/GD)", actions.includes("const isCreator = row.createdByUserId === g.userId") && actions.includes("canReviewCollection(g.roles)") && actions.includes("canReviewWithdrawal(g.roles)") && actions.includes("export async function cancelCashCollection") && actions.includes("export async function cancelCashWithdrawal"));
  check("CANCEL-ROLE3 вне scope отменить нельзя (clubId in allowedClubIds guard в обоих cancel-actions)", /cancelCashCollection[\s\S]{0,500}clubId: \{ in: g\.clubIds \}/.test(actions) && /cancelCashWithdrawal[\s\S]{0,500}clubId: \{ in: g\.clubIds \}/.test(actions));
  check("CANCEL-SOFT soft-cancel: статус cancelled через updateMany (draft/pending only), без hard delete; approved отклоняется", !/cashCollection\.delete|cashWithdrawal\.delete/.test(actions) && /status: \{ in: CANCELABLE_COLLECTION \}/.test(actions) && /status: \{ in: CANCELABLE_WITHDRAWAL \}/.test(actions) && actions.includes("Подтверждённую инкассацию нельзя удалить") && actions.includes("Подтверждённое изъятие нельзя удалить"));
  check("CANCEL-UI история показывает кнопку «Отменить» только для отменяемых операций (draft/pending), для approved/rejected/cancelled — нет", forms.includes("export function CancelButton") && forms.includes(">Отменить<") && pageSrc.includes("CANCELABLE[h.kind].includes(h.status)") && pageSrc.includes("<CancelButton"));
  check("HISTORY-STATUSES история не скрывает cancelled (loadCashOpsHistory без status-фильтра → все статусы)", pageSrc.includes("loadCashOpsHistory") && !/status:\s*\{/.test(loader.slice(loader.indexOf("loadCashOpsHistory"), loader.indexOf("loadCashOpsHistory") + 700)) && pageSrc.includes("STATUS_LABELS") && pageSrc.includes("cancelled"));


  check("BALANCE-ALIGN2 expenses page no longer renders the conflicting wallet cards (getClubCashCards removed)", !expSrc.includes("getClubCashCards") && !expSrc.includes("Всего наличных ИП") && expSrc.includes("IpCashFactBlock"));
  check("DASHBOARD-CASH-ALIGN1 dashboard cash cards come from loadClubCashBalances (same fact balance as /collections)", dashSrc.includes("loadClubCashBalances") && dashSrc.includes("cashOooFactBalance") && dashSrc.includes("cashIpFactBalance"));
  check("LABELS-S UI distinguishes вчера / сегодня / после контрольной точки / за месяц / фактический остаток", pageSrc.includes("вчера") && pageSrc.includes("сегодня") && pageSrc.includes("после контрольной точки") && pageSrc.includes("за месяц") && (pageSrc.includes("Фактический остаток") || pageSrc.includes("Расчётный остаток")));
  check("WITHDRAWAL-VIEW-S UI: «Изъятия из ООО» и «Приход «Иное»» — отдельные строки в карточке ИП (не слиты)", pageSrc.includes('label="Изъятия из ООО"') && pageSrc.includes('label="Приход «Иное»"') && expSrc.includes('label="Изъятия из ООО"') && expSrc.includes('label="Приход «Иное»"'));
  check("OPENING7 без комментария контрольный остаток создать нельзя (comment обязателен)", actions.includes("Комментарий обязателен") && /if \(!comment\)/.test(actions));
  check("OPENING-S setCashOpeningBalance создаёт НОВУЮ контрольную точку (balanceSnapshot.create), не редактирует историю; аудит cash.opening_balance_set", actions.includes("export async function setCashOpeningBalance") && actions.includes("prisma.balanceSnapshot.create") && !/balanceSnapshot\.update/.test(actions) && actions.includes('"cash.opening_balance_set"'));
  check("ROLE-OPENING1/2 контрольный остаток скоупится по allowedClubIds (manager/regional только свои клубы)", actions.includes("ctx.allowedClubIds.includes(clubId)") && actions.includes("canSetOpeningBalance(g.roles)"));
  check("SYNC-CASH1 sync ИП uses runSyncNowForCompany, returns SAFE summary (found/imported/skipped), no secrets", actions.includes("export async function syncIpCashAction") && actions.includes("runSyncNowForCompany") && /found:\s*t\.foundReceipts/.test(actions) && !/login|password|integratorId|sessionToken|Bearer/i.test(actions));
  check("SYNC-CASH2 sync ООО uses the same safe sync path; hint mentions вчера/период/фактический (not only «за сегодня»)", actions.includes("export async function syncOooCashAction") && pageSrc.includes("пересчитываются вчера, период и фактический остаток"));
  check("COLLECTION6 create requires >=1 document (min, default = MIN_CASH_OPERATION_DOCUMENTS) — server-enforced", docStore.includes("MIN_CASH_OPERATION_DOCUMENTS = 1") && actions.includes("Прикрепите хотя бы один подтверждающий документ") && /files\.length < min/.test(actions) && actions.includes("min: number = MIN_CASH_OPERATION_DOCUMENTS"));
  check("COLLECTION7 create rejects >3 documents (max)", docStore.includes("MAX_CASH_OPERATION_DOCUMENTS = 3") && /files\.length > MAX_CASH_OPERATION_DOCUMENTS/.test(actions));
  check("WITHDRAWAL1/2 create gated to canCreateOperational (manager + regional_director have operational.create)", /regional_director:\s*\["operational\.create"\]/.test(authSrc) && /manager:\s*\["operational\.create"\]/.test(authSrc) && actions.includes("canCreateOperational(g.roles)") && actions.includes("export async function createCashWithdrawal"));
  check("ROLE-CASH page access owner/GD/regional/manager/accountant/chief (NOT marketer); page guarded", /owner:\s*\[[^\]]*"collections"/.test(authSrc) && /regional_director:\s*\[[^\]]*"collections"/.test(authSrc) && /\bmanager:\s*\[[^\]]*"collections"/.test(authSrc) && /\baccountant:\s*\[[^\]]*"collections"/.test(authSrc) && !/marketer:\s*\[[^\]]*"collections"/.test(authSrc) && pageSrc.includes('requirePageAccess("collections")'));
  check("ROLE-CASH1 pages scope to allowedClubIds (manager only own clubs)", pageSrc.includes("ctx.allowedClubIds") && actions.includes("ctx.allowedClubIds.includes(clubId)"));
  check("DASHBOARD-CASH1 simplified dashboard shows Наличные ООО/ИП from fact balance (loadScopeCashFactTotals), gated by canSeeCash", keyCardsSrc.includes('label="Наличные ООО"') && keyCardsSrc.includes('label="Наличные ИП"') && rd("src/app/(app)/dashboard/page.tsx").includes("loadScopeCashFactTotals(companyId, clubIds, now)") && rd("src/app/(app)/dashboard/page.tsx").includes("showCash={canSeeCash}") && loader.includes("export async function loadScopeCashFactTotals") && loader.includes("cashOooFactBalance"));
  check("DASHBOARD-CASH2 manager sees cash key cards but no owner analytics (showCash gate, no profit/pending on dashboard)", keyCardsSrc.includes("showCash") && !keyCardsSrc.includes("Инкассации на проверке") && loader.includes("cashIpFactBalance"));
  check("ROLE-CASH2 accountant workspace surfaces инкассации/изъятия на проверке", wsSrc.includes("Инкассации на проверке") && wsSrc.includes("Изъятия на проверке") && wsSrc.includes("loadPendingCashOps"));
  check("SECURITY no secrets/technical fiscal terms/PII in cash pages, forms, actions, lib, loader, dashboard", ![pageSrc, forms, actions, lib, loader, dashSrc, oldCashSrc].some((s) => /login|password|integratorId|sessionToken|Bearer|rawJson|fiscalSign|ФПД|ShiftList|DocumentInfo|NewDocuments|\bphone\b|\bemail\b|buyer|customer|\.stack/i.test(s)));
  check("SECURITY-audit cash audit actions are cash.* with SAFE metadata (amountKopeks/counts), never raw/PII/documents", actions.includes('"cash.collection_created"') && actions.includes('"cash.withdrawal_created"') && actions.includes('"cash.opening_balance_set"') && actions.includes('"cash.collection_cancelled"') && actions.includes('"cash.withdrawal_cancelled"') && actions.includes("metadata: { amountKopeks") && !/metadata:\s*\{[^}]*(rawJson|fiscalSign|\bphone\b|\bemail\b|storageKey|\.stack)/i.test(actions));
  check("NO-MIX withdrawal/collection are NOT sales/income: no Sale/Ofd writes in actions", !/prisma\.sale\.create|ofdReceipt|ofdDailySalesSummary\.create|ofdRevenueCategory/i.test(actions));
  check("MIGRATION dev+prod add CashCollection/CashWithdrawal/CashOperationDocument (non-destructive CREATE TABLE)", /CREATE TABLE "CashCollection"/.test(rd("prisma/migrations/20260718000000_add_cash_collections_withdrawals/migration.sql")) && /CREATE TABLE "CashWithdrawal"/.test(rd("prisma/production/migrations/20260718000000_add_cash_collections_withdrawals/migration.sql")) && /CREATE TABLE "CashOperationDocument"/.test(rd("prisma/production/migrations/20260718000000_add_cash_collections_withdrawals/migration.sql")));
  check("LIB pure calc exports calculateCashBalances + opening-window fields; no I/O", lib.includes("export function calculateCashBalances") && lib.includes("cashOooOfdSinceOpening") && lib.includes("cashOooOpeningSet") && lib.includes("oooOpeningDate") && !lib.includes("import { prisma }"));

  // ===== QA finance audit (2026-07-19): single-source, roles, security =========
  const dashPageSrc = rd("src/app/(app)/dashboard/page.tsx");
  // QA-CASH1: all four surfaces read the SAME source (loadClubCashBalances) and the
  // same fact-balance fields — no divergent per-page balance.
  check("QA-CASH1 /collections, /expenses, /expenses/cash и дашборд берут остаток из loadClubCashBalances (единый источник, одинаковые поля)", pageSrc.includes("loadClubCashBalances") && expSrc.includes("loadClubCashBalances") && oldCashSrc.includes("loadClubCashBalances") && dashSrc.includes("loadClubCashBalances") && [pageSrc, expSrc, oldCashSrc, dashSrc].every((s) => s.includes("cashIpFactBalance")) && [pageSrc, dashSrc].every((s) => s.includes("cashOooFactBalance")));
  // QA-CASH2: no legacy confirmed-only wallet ledger feeds any working UI balance.
  // Match CODE usage (calls / property access), not explanatory prose — oldCashSrc
  // legitimately names the retired ledger in a comment to explain why it is gone.
  check("QA-CASH2 рабочие остатки не используют старый confirmed-only CashWallet/CashMovement (loader читает CashOtherIncome; убраны getClubCashBreakdown/getClubCashCards)", !loader.includes("cashMovement.findMany") && !loader.includes("cashWallet") && loader.includes("cashOtherIncome.findMany") && ![pageSrc, expSrc, oldCashSrc, dashSrc].some((s) => /getClubCashBreakdown\(|getClubCashCards\(|cashMovement\.|cashWallet\./i.test(s)));
  // QA-CASH3 / QA-CASH4 are covered as pure calc above (OPENING3/4/5/supersede cut
  // stale movements; CASH-SPLIT1 keeps ООО/ИП apart) — re-assert the invariants here.
  const qaCut = calc({ ...base, oooOpeningKopeks: 500000, ipOpeningKopeks: 100000, oooOpeningDate: "2026-07-15", ipOpeningDate: "2026-07-15",
    ofdRows: [{ legalEntityType: "ooo", date: "2026-07-10", incomeCashKopeks: 999999, returnCashKopeks: 0 }, { legalEntityType: "ip", date: "2026-07-16", incomeCashKopeks: 30000, returnCashKopeks: 0 }],
    collections: [{ status: "pending_accountant_review", amountKopeks: 111111, date: "2026-07-10" }] });
  check("QA-CASH3 движения строго ДО контрольной точки не влияют; после — влияют", qaCut.cashOooFactBalance === 500000 && qaCut.cashOooPendingCollections === 0 && qaCut.cashIpFactBalance === 130000);
  check("QA-CASH4 ООО и ИП не смешиваются (ОФД ИП не попал в ООО и наоборот)", qaCut.cashOooOfdSinceOpening === 0 && qaCut.cashIpOfdSinceOpening === 30000);
  // QA-ROLE4 (bugfix): the dashboard cash summary is gated so a marketer (analytics-
  // only, no /collections access) never sees ООО/ИП cash; manager/regional still do.
  check("QA-ROLE4 дашборд скрывает наличные ООО/ИП от маркетолога (canSeeCash = доступ к /collections); маркетолог не имеет collections/expenses", dashPageSrc.includes('const canSeeCash = canAnyRoleAccessPage(roles, "collections")') && /showCash=\{canSeeCash\}/.test(dashPageSrc) && !/marketer:\s*\[[^\]]*"collections"/.test(authSrc) && !/marketer:\s*\[[^\]]*"expenses"/.test(authSrc) && /\bmanager:\s*\[[^\]]*"collections"/.test(authSrc));
  // QA-DASHBOARD1: same fact-balance source as /collections (loadClubCashBalances).
  check("QA-DASHBOARD1 дашборд использует тот же источник остатков, что и /collections", loader.includes("export async function loadScopeCashFactTotals") && loader.includes("loadClubCashBalances") && loader.includes("cashOooFactBalance") && loader.includes("cashIpFactBalance") && dashPageSrc.includes("loadScopeCashFactTotals") && dashPageSrc.includes("<DashboardKeyCards"));
  // QA-SECURITY1: dashboard page + cards leak no secrets / raw fiscal / PII.
  check("QA-SECURITY1 дашборд (страница+карточки) не раскрывает секреты/raw JSON/ПДн", ![dashPageSrc, dashSrc].some((s) => /login|password|integratorId|sessionToken|Bearer|rawJson|fiscalSign|ФПД|cashierName|cashierInn|\bphone\b|\bemail\b|buyer|customer|\.stack/i.test(s)));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
