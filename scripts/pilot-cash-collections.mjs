// Cash contour: fact balances (ООО/ИП), collections (инкассация), withdrawals
// (изъятие ООО→ИП). Mirrors src/lib/cash-balances.ts + the loader, plus DB
// round-trips and static source guards. Real Taxcom API is never called.
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? `  ${x}` : ""}`); c ? pass++ : fail++; };

const CO = "pilot-cash-co", CLUB = "pilot-cash-club", U = "pilot-cash-user";
const OOO = "pilot-cash-ooo", IP = "pilot-cash-ip";

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
const sum = (xs) => xs.reduce((a, x) => a + (x.amountKopeks || 0), 0);
const withS = (xs, allowed) => xs.filter((x) => allowed.includes(x.status));
const ofdNet = (rows, t) => rows.filter((r) => r.legalEntityType === t).reduce((a, r) => a + (r.incomeCashKopeks || 0) - (r.returnCashKopeks || 0), 0);
const ofdNetDay = (rows, t, d) => rows.filter((r) => r.legalEntityType === t && r.date === d).reduce((a, r) => a + (r.incomeCashKopeks || 0) - (r.returnCashKopeks || 0), 0);
function calc(input) {
  const cashIpOpening = input.ipOpeningKopeks || 0;
  const cashIpOfdIncome = ofdNet(input.ofdRows, "ip");
  const cashIpOfdYesterday = ofdNetDay(input.ofdRows, "ip", input.yesterday);
  const cashIpWithdrawalsFromOoo = sum(withS(input.withdrawals, WITHDRAWAL_FACT));
  const cashIpOtherIncome = input.ipOtherIncomeKopeks || 0;
  const cashIpPendingExpenses = sum(withS(input.ipExpenses, IP_EXP_PENDING));
  const cashIpApprovedExpenses = sum(withS(input.ipExpenses, IP_EXP_APPROVED));
  const cashIpFactBalance = cashIpOpening + cashIpOfdIncome + cashIpWithdrawalsFromOoo + cashIpOtherIncome - cashIpPendingExpenses - cashIpApprovedExpenses;
  const cashOooOpening = input.oooOpeningKopeks || 0;
  const cashOooOfdIncome = ofdNet(input.ofdRows, "ooo");
  const cashOooOfdYesterday = ofdNetDay(input.ofdRows, "ooo", input.yesterday);
  const cashOooPendingCollections = sum(withS(input.collections, [COLLECTION_STATUS.PENDING]));
  const cashOooApprovedCollections = sum(withS(input.collections, [COLLECTION_STATUS.APPROVED]));
  const cashOooPendingWithdrawalsToIp = sum(withS(input.withdrawals, [WITHDRAWAL_STATUS.PENDING]));
  const cashOooApprovedWithdrawalsToIp = sum(withS(input.withdrawals, [WITHDRAWAL_STATUS.APPROVED]));
  const cashOooFactBalance = cashOooOpening + cashOooOfdIncome - cashOooPendingCollections - cashOooApprovedCollections - cashOooPendingWithdrawalsToIp - cashOooApprovedWithdrawalsToIp;
  return { cashIpOpening, cashIpOfdIncome, cashIpOfdYesterday, cashIpWithdrawalsFromOoo, cashIpOtherIncome, cashIpPendingExpenses, cashIpApprovedExpenses, cashIpFactBalance, cashOooOpening, cashOooOfdIncome, cashOooOfdYesterday, cashOooPendingCollections, cashOooApprovedCollections, cashOooPendingWithdrawalsToIp, cashOooApprovedWithdrawalsToIp, cashOooFactBalance };
}
const base = { oooOpeningKopeks: 0, ipOpeningKopeks: 0, ofdRows: [], yesterday: "2026-07-17", collections: [], withdrawals: [], ipExpenses: [], ipOtherIncomeKopeks: 0 };

// Mirror loader: query DB rows for a club and run calc (no baseline snapshots here).
async function loadClubCash(companyId, clubId, yesterday) {
  const typeById = new Map([[OOO, "ooo"], [IP, "ip"]]);
  const [ofd, collections, withdrawals, ipExpenses] = await Promise.all([
    p.ofdDailySalesSummary.findMany({ where: { companyId, clubId, provider: "taxcom" }, select: { legalEntityId: true, date: true, incomeCashKopeks: true, returnCashKopeks: true } }),
    p.cashCollection.findMany({ where: { clubId }, select: { status: true, amountKopeks: true } }),
    p.cashWithdrawal.findMany({ where: { clubId }, select: { status: true, amountKopeks: true } }),
    p.expense.findMany({ where: { clubId, legalEntityId: IP, paymentMethod: "cash", entryVersion: 2 }, select: { status: true, amountKopeks: true } }),
  ]);
  return calc({ ...base, yesterday, ofdRows: ofd.map((r) => ({ legalEntityType: r.legalEntityId ? typeById.get(r.legalEntityId) ?? null : null, date: r.date, incomeCashKopeks: r.incomeCashKopeks, returnCashKopeks: r.returnCashKopeks })), collections, withdrawals, ipExpenses });
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
  check("CASH-SPLIT1 ОФД cash ИП counted separately from ООО", r1.cashOooOfdIncome === 300000 && r1.cashIpOfdIncome === 200000 && r1.cashOooOfdIncome !== r1.cashIpOfdIncome, `ooo=${r1.cashOooOfdIncome} ip=${r1.cashIpOfdIncome}`);
  check("CASH-SPLIT2 приход ИП вчера = OFD cash по ИП за yesterday (net of returns)", r1.cashIpOfdYesterday === 100000, `ip_yday=${r1.cashIpOfdYesterday}`);
  check("CASH-SPLIT3 приход ООО вчера = OFD cash по ООО за yesterday", r1.cashOooOfdYesterday === 300000, `ooo_yday=${r1.cashOooOfdYesterday}`);

  const rPend = calc({ ...base, ipExpenses: [{ status: "pending_accountant_verification", amountKopeks: 40000 }] });
  check("CASH-IP1 pending ИП-расход сразу уменьшает фактический остаток ИП", rPend.cashIpFactBalance === -40000 && rPend.cashIpPendingExpenses === 40000);
  const rRej = calc({ ...base, ipExpenses: [{ status: "cancelled", amountKopeks: 40000 }, { status: "rejected", amountKopeks: 10000 }] });
  check("CASH-IP2 отклонённый/отменённый ИП-расход не уменьшает остаток", rRej.cashIpFactBalance === 0 && rRej.cashIpPendingExpenses === 0 && rRej.cashIpApprovedExpenses === 0);
  const rDraft = calc({ ...base, ipExpenses: [{ status: "draft", amountKopeks: 99999 }] });
  check("CASH-IP3 черновик ИП-расхода не уменьшает остаток", rDraft.cashIpFactBalance === 0);
  const rMix = calc({ ...base, ipExpenses: [{ status: "pending_accountant_verification", amountKopeks: 40000 }, { status: "verified", amountKopeks: 25000 }] });
  check("CASH-IP4 аналитика: approved считает только verified/confirmed, pending отдельно (без двойного счёта в approved)", rMix.cashIpApprovedExpenses === 25000 && rMix.cashIpPendingExpenses === 40000 && rMix.cashIpFactBalance === -65000);

  // ===== Pure calc: collections + withdrawals ================================
  const rColP = calc({ ...base, oooOpeningKopeks: 500000, collections: [{ status: COLLECTION_STATUS.PENDING, amountKopeks: 200000 }] });
  check("COLLECTION2 инкассация pending сразу уменьшает фактический остаток ООО", rColP.cashOooFactBalance === 300000 && rColP.cashOooPendingCollections === 200000);
  const rColR = calc({ ...base, oooOpeningKopeks: 500000, collections: [{ status: COLLECTION_STATUS.REJECTED, amountKopeks: 200000 }, { status: COLLECTION_STATUS.CANCELLED, amountKopeks: 100000 }] });
  check("COLLECTION3 отклонённая/отменённая инкассация возвращает сумму в остаток ООО", rColR.cashOooFactBalance === 500000 && rColR.cashOooPendingCollections === 0 && rColR.cashOooApprovedCollections === 0);
  const rColA = calc({ ...base, oooOpeningKopeks: 500000, collections: [{ status: COLLECTION_STATUS.APPROVED, amountKopeks: 200000 }] });
  check("COLLECTION-approve инкассация approved не меняет остаток второй раз (pending→approved = один вычет)", rColA.cashOooFactBalance === 300000 && rColA.cashOooFactBalance === rColP.cashOooFactBalance);
  check("COLLECTION4 инкассация уменьшает только ООО (ИП не затрагивается)", rColP.cashIpFactBalance === 0);

  const rW = calc({ ...base, oooOpeningKopeks: 500000, ipOpeningKopeks: 100000, withdrawals: [{ status: WITHDRAWAL_STATUS.PENDING, amountKopeks: 120000 }] });
  check("WITHDRAWAL3 изъятие pending сразу уменьшает ООО и увеличивает ИП", rW.cashOooFactBalance === 380000 && rW.cashIpFactBalance === 220000 && rW.cashIpWithdrawalsFromOoo === 120000);
  const rWa = calc({ ...base, oooOpeningKopeks: 500000, ipOpeningKopeks: 100000, withdrawals: [{ status: WITHDRAWAL_STATUS.APPROVED, amountKopeks: 120000 }] });
  check("WITHDRAWAL4 подтверждение изъятия не меняет остатки второй раз", rWa.cashOooFactBalance === 380000 && rWa.cashIpFactBalance === 220000);
  const rWr = calc({ ...base, oooOpeningKopeks: 500000, ipOpeningKopeks: 100000, withdrawals: [{ status: WITHDRAWAL_STATUS.REJECTED, amountKopeks: 120000 }] });
  check("WITHDRAWAL5 отклонение/отмена изъятия откатывает: ООО назад вверх, ИП назад вниз", rWr.cashOooFactBalance === 500000 && rWr.cashIpFactBalance === 100000 && rWr.cashIpWithdrawalsFromOoo === 0);

  // ===== DB round-trips ======================================================
  const now = new Date();
  const mkSummary = (legal, date, cash) => p.ofdDailySalesSummary.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: legal, provider: "taxcom", date, summaryKey: `${CO}:${CLUB}:${legal}:taxcom:${date}`, incomeTotalKopeks: cash, incomeCashKopeks: cash, incomeElectronicKopeks: 0, returnTotalKopeks: 0, returnCashKopeks: 0, returnElectronicKopeks: 0, netTotalKopeks: cash, receiptCount: 1, returnReceiptCount: 0 } });
  await mkSummary(OOO, "2026-07-17", 300000);
  await mkSummary(IP, "2026-07-17", 150000);
  const dbSplit = await loadClubCash(CO, CLUB, "2026-07-17");
  check("CASH-SPLIT-DB OFD summaries split ООО/ИП cash from OfdDailySalesSummary by legalEntityId", dbSplit.cashOooOfdIncome === 300000 && dbSplit.cashIpOfdIncome === 150000 && dbSplit.cashOooOfdYesterday === 300000 && dbSplit.cashIpOfdYesterday === 150000);

  const col = await p.cashCollection.create({ data: { companyId: CO, clubId: CLUB, legalEntityId: OOO, amountKopeks: 200000, operationDate: now, status: "pending_accountant_review", createdByUserId: U } });
  await p.cashOperationDocument.create({ data: { collectionId: col.id, companyId: CO, clubId: CLUB, storageKey: `cash-docs/${"a".repeat(64)}.pdf`, originalFilename: "act.pdf", safeFilename: "act.pdf", mimeType: "application/pdf", sizeBytes: 100, sha256: "x", uploadedByUserId: U } });
  check("COLLECTION1 инкассация ООО создаётся (сумма/дата/статус pending) с документом", col.status === "pending_accountant_review" && col.legalEntityId === OOO && (await p.cashOperationDocument.count({ where: { collectionId: col.id } })) === 1);
  const afterCol = await loadClubCash(CO, CLUB, "2026-07-17");
  check("COLLECTION2-DB инкассация pending уменьшает фактический остаток ООО (через модель)", afterCol.cashOooPendingCollections === 200000 && afterCol.cashOooFactBalance === 300000 - 200000);
  // Accountant approves (mirror of updateMany status guard).
  const okApprove = await p.cashCollection.updateMany({ where: { id: col.id, status: "pending_accountant_review" }, data: { status: "approved", reviewedByUserId: U, reviewedAt: now } });
  check("COLLECTION5 бухгалтер подтверждает инкассацию (pending→approved, идемпотентно)", okApprove.count === 1 && (await p.cashCollection.updateMany({ where: { id: col.id, status: "pending_accountant_review" }, data: { status: "approved" } })).count === 0);
  const afterApprove = await loadClubCash(CO, CLUB, "2026-07-17");
  check("COLLECTION-approve-DB approved не меняет остаток ООО второй раз", afterApprove.cashOooFactBalance === afterCol.cashOooFactBalance);
  await p.cashCollection.updateMany({ where: { id: col.id }, data: { status: "rejected" } });
  const afterReject = await loadClubCash(CO, CLUB, "2026-07-17");
  check("COLLECTION3-DB отклонённая инкассация возвращает остаток ООО", afterReject.cashOooFactBalance === 300000 && afterReject.cashOooPendingCollections === 0 && afterReject.cashOooApprovedCollections === 0);

  const wd = await p.cashWithdrawal.create({ data: { companyId: CO, clubId: CLUB, fromLegalEntityId: OOO, toLegalEntityId: IP, amountKopeks: 120000, operationDate: now, status: "pending_review", createdByUserId: U } });
  const afterWd = await loadClubCash(CO, CLUB, "2026-07-17");
  check("WITHDRAWAL3-DB изъятие pending: ООО ↓ и ИП ↑ (через модель)", afterWd.cashOooFactBalance === 300000 - 120000 && afterWd.cashIpFactBalance === 150000 + 120000 && wd.fromLegalEntityId === OOO && wd.toLegalEntityId === IP);
  await p.cashWithdrawal.updateMany({ where: { id: wd.id }, data: { status: "rejected" } });
  const afterWdRej = await loadClubCash(CO, CLUB, "2026-07-17");
  check("WITHDRAWAL5-DB отклонение изъятия откатывает ООО и ИП", afterWdRej.cashOooFactBalance === 300000 && afterWdRej.cashIpFactBalance === 150000);

  // Withdrawal is not a sale / not OFD / not revenue: no Sale row, no Ofd rows created by it.
  check("WITHDRAWAL6/7/8 изъятие не создаёт Sale, не попадает в ОФД-продажи/статьи доходов", (await p.sale.count({ where: { companyId: CO } }).catch(() => 0)) === 0 && (await p.ofdReceiptItem.count({ where: { companyId: CO } }).catch(() => 0)) === 0 && (await p.ofdReceiptImport.count({ where: { companyId: CO } }).catch(() => 0)) === 0);

  // ===== Static source guards ================================================
  const rd = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const lib = rd("src/lib/cash-balances.ts");
  const loader = rd("src/lib/cash-collections.ts");
  const actions = rd("src/app/(app)/collections/actions.ts");
  const pageSrc = rd("src/app/(app)/collections/page.tsx");
  const forms = rd("src/app/(app)/collections/_components/CollectionForms.tsx");
  const authSrc = rd("src/lib/auth.ts");
  const navSrc = rd("src/lib/navigation.ts");
  const dashSrc = rd("src/app/(app)/dashboard/_components/CashScopeSummary.tsx");
  const wsSrc = rd("src/app/(app)/workspace/page.tsx");
  const docStore = rd("src/lib/cash-document-storage.ts");

  check("CASH-IP-S expenses page shows ИП fact block + Синхронизировать наличные ИП", rd("src/app/(app)/expenses/page.tsx").includes("IpCashFactBlock") && forms.includes("Синхронизировать наличные ИП"));
  check("SYNC-CASH1 sync ИП uses runSyncNowForCompany, returns SAFE summary (found/imported/skipped), no secrets", actions.includes("export async function syncIpCashAction") && actions.includes("runSyncNowForCompany") && /found:\s*t\.foundReceipts/.test(actions) && !/login|password|integratorId|sessionToken|Bearer/i.test(actions));
  check("SYNC-CASH2 sync ООО uses the same safe sync path", actions.includes("export async function syncOooCashAction") && actions.includes("runSyncNowForCompany"));
  check("COLLECTION6 create requires >=1 document (min) — server-enforced", docStore.includes("MIN_CASH_OPERATION_DOCUMENTS = 1") && actions.includes("Прикрепите хотя бы один подтверждающий документ") && /files\.length < MIN_CASH_OPERATION_DOCUMENTS/.test(actions));
  check("COLLECTION7 create rejects >3 documents (max)", docStore.includes("MAX_CASH_OPERATION_DOCUMENTS = 3") && /files\.length > MAX_CASH_OPERATION_DOCUMENTS/.test(actions));
  check("WITHDRAWAL1/2 create gated to canCreateOperational (manager + regional_director have operational.create)", /regional_director:\s*\["operational\.create"\]/.test(authSrc) && /manager:\s*\["operational\.create"\]/.test(authSrc) && actions.includes("canCreateOperational(g.roles)") && actions.includes("export async function createCashWithdrawal"));
  check("ROLE-CASH: collections page access owner/GD/regional/manager/accountant/chief (NOT marketer); page guarded", /owner:\s*\[[^\]]*"collections"/.test(authSrc) && /regional_director:\s*\[[^\]]*"collections"/.test(authSrc) && /\bmanager:\s*\[[^\]]*"collections"/.test(authSrc) && /\baccountant:\s*\[[^\]]*"collections"/.test(authSrc) && !/marketer:\s*\[[^\]]*"collections"/.test(authSrc) && pageSrc.includes('requirePageAccess("collections")'));
  check("ROLE-CASH1 page scopes to allowedClubIds (manager only own clubs) — no cross-club", pageSrc.includes("ctx.allowedClubIds") && actions.includes("ctx.allowedClubIds.includes(clubId)"));
  check("DASHBOARD-CASH1 dashboard cash cards: ООО/ИП + pending counters, review counters gated by financials", dashSrc.includes("Наличные ООО") && dashSrc.includes("Наличные ИП") && dashSrc.includes("Инкассации на проверке") && dashSrc.includes("Изъятия на проверке") && dashSrc.includes("showPending") && rd("src/app/(app)/dashboard/page.tsx").includes("showPending={financials}"));
  check("DASHBOARD-CASH2 manager sees operational balances w/o review counters (showPending=false hides pending)", /showPending \? [\s\S]{0,200}Инкассации на проверке/.test(dashSrc) && dashSrc.includes("showPending ? "));
  check("ROLE-CASH2 accountant workspace surfaces инкассации/изъятия на проверке", wsSrc.includes("Инкассации на проверке") && wsSrc.includes("Изъятия на проверке") && wsSrc.includes("loadPendingCashOps"));
  check("SECURITY no secrets/technical fiscal terms/PII in cash page, forms, actions, lib, loader", ![pageSrc, forms, actions, lib, loader, dashSrc].some((s) => /login|password|integratorId|sessionToken|Bearer|rawJson|fiscalSign|ФПД|ShiftList|DocumentInfo|NewDocuments|phone|email|buyer|customer|\.stack/i.test(s)));
  check("SECURITY-audit cash audit actions are cash.* with SAFE metadata (amountKopeks/counts), never raw/PII", actions.includes('"cash.collection_created"') && actions.includes('"cash.withdrawal_created"') && actions.includes("metadata: { amountKopeks") && !/metadata:\s*\{[^}]*(rawJson|fiscalSign|phone|email|\.stack)/i.test(actions));
  check("NO-MIX withdrawal/collection are NOT sales/income: no Sale/Ofd writes in actions", !/prisma\.sale\.create|ofdReceipt|ofdDailySalesSummary\.create|ofdRevenueCategory/i.test(actions));
  check("MIGRATION dev+prod add CashCollection/CashWithdrawal/CashOperationDocument (non-destructive CREATE TABLE)", /CREATE TABLE "CashCollection"/.test(rd("prisma/migrations/20260718000000_add_cash_collections_withdrawals/migration.sql")) && /CREATE TABLE "CashWithdrawal"/.test(rd("prisma/production/migrations/20260718000000_add_cash_collections_withdrawals/migration.sql")) && /CREATE TABLE "CashOperationDocument"/.test(rd("prisma/production/migrations/20260718000000_add_cash_collections_withdrawals/migration.sql")));
  check("LIB pure calc exports calculateCashBalances + status sets; no I/O", lib.includes("export function calculateCashBalances") && lib.includes("COLLECTION_STATUS") && lib.includes("WITHDRAWAL_STATUS") && lib.includes("IP_EXPENSE_PENDING_STATUSES") && !lib.includes("import { prisma }"));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
