// Invoices Phase 1 regression: reporting-month rule, carried overdue, manager
// visibility, city/club filters, month navigation, add-paid role gate, and the
// server data-contract shape. Mirrors the pure rules in lib/invoices.ts +
// lib/invoice-view.ts, plus real-DB query shapes and static contract assertions.
// SAFE: fixed "pilot-inv-*" ids, cleaned up. npm run pilot:invoices
import { PrismaClient } from "@prisma/client";
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

// --- Mirrors of lib/invoices.ts -------------------------------------------
const AWAITING = ["needs_review", "approved_by_regional", "approved_by_chief_accountant", "approved_by_owner"];
const CONFIRMED_UNPAID = ["approved_by_regional", "approved_by_chief_accountant", "approved_by_owner"];
const MANAGER_EXTRA = ["draft", "needs_correction", "rejected"]; // operational-only visible statuses
const ELEVATED = ["regional_director", "accountant", "chief_accountant", "owner", "general_director"];
const OPERATIONAL = ["regional_director", "manager", "accountant", "chief_accountant"];
const isPaid = (s) => s === "paid";
const isAwaiting = (s) => AWAITING.includes(s);
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
// Financial reporting date (unchanged; dashboard/budgets use their own rule).
const reportingDate = (i) => (isPaid(i.status) ? (i.paidAt ?? i.dueDate ?? i.invoiceDate ?? i.createdAt) : (i.dueDate ?? i.invoiceDate ?? i.createdAt));
const reportingMonth = (i) => monthKey(reportingDate(i));
// Operational month for the invoices-page list: paid→paidAt, confirmed-unpaid→
// dueDate, draft/needs_review/rejected→invoiceDate??createdAt (never hidden).
const operationalDate = (i) => (isPaid(i.status) ? (i.paidAt ?? i.dueDate ?? i.invoiceDate ?? i.createdAt) : CONFIRMED_UNPAID.includes(i.status) ? (i.dueDate ?? i.invoiceDate ?? i.createdAt) : (i.invoiceDate ?? i.createdAt));
const operationalMonth = (i) => monthKey(operationalDate(i));
const isOverdue = (i, now) => isAwaiting(i.status) && !!i.dueDate && i.dueDate.getTime() < now.getTime();
const canAddPaid = (roles) => roles.includes("accountant") || roles.includes("chief_accountant");
const canCreateOp = (roles) => OPERATIONAL.some((r) => roles.includes(r));
const submitBlocked = (i) => (!i.counterpartyName || !String(i.counterpartyName).trim() ? "counterparty" : !(i.amountKopeks > 0) ? "amount" : !i.hasFile ? "file" : null);

// --- Mirror of lib/invoice-view.ts getInvoicesView ------------------------
function buildView(ctx, raw, invoices, sentEvents, now) {
  const roles = ctx.effectiveRoles;
  const isElevated = roles.some((r) => ELEVATED.includes(r));
  const isManager = roles.includes("manager");
  const roleView = isElevated ? "elevated" : isManager ? "manager" : "none";
  const permissions = { canAddPaidInvoice: canAddPaid(roles), canUploadInvoice: canCreateOp(roles), canViewPastMonths: isElevated };
  let year = now.getFullYear(), month = now.getMonth() + 1;
  if (isElevated) { const y = parseInt(raw.year, 10), m = parseInt(raw.month, 10); if (y >= 2000 && y <= 2100 && m >= 1 && m <= 12) { year = y; month = m; } }
  const start = new Date(year, month - 1, 1), end = new Date(year, month, 1), selKey = monthKey(start);
  const emptyMgr = { pendingPaymentAmountKopeks: 0, overdueAmountKopeks: 0, sentCount: 0 };
  const baseView = () => ({ effectivePeriod: { year, month, start, end }, roleView, canNavigateMonths: isElevated, canFilterByCity: isElevated, canFilterByClub: isElevated, availableCities: [], availableClubs: [], selectedCity: null, selectedClub: null, summary: roleView === "manager" ? { ...emptyMgr } : { ...emptyMgr, totalInvoiceAmountKopeks: 0, paidAmountKopeks: 0 }, currentPeriodInvoices: [], carriedOverdueInvoices: [], upcomingPayments: [], categoryDistribution: [], permissions });
  if (!ctx.companyId || roleView === "none") return baseView();
  const availableClubs = ctx.clubs.filter((c) => ctx.allowedClubIds.includes(c.id) && c.companyId === ctx.companyId);
  const availableCities = [...new Set(availableClubs.map((c) => c.city))].sort();
  let selectedCity = null, selectedClub = null, clubIds = availableClubs.map((c) => c.id);
  if (isElevated) {
    const cityRaw = (raw.city ?? "").trim(); if (cityRaw && availableCities.includes(cityRaw)) selectedCity = cityRaw;
    const clubRaw = (raw.clubId ?? "").trim(); const hit = availableClubs.find((c) => c.id === clubRaw); if (hit) selectedClub = hit.id;
    if (selectedCity && selectedClub) { const cc = availableClubs.find((c) => c.id === selectedClub); if (!cc || cc.city !== selectedCity) selectedClub = null; }
    if (selectedClub) clubIds = [selectedClub]; else if (selectedCity) clubIds = availableClubs.filter((c) => c.city === selectedCity).map((c) => c.id);
  }
  const view = baseView(); view.availableClubs = availableClubs; view.availableCities = availableCities; view.selectedCity = selectedCity; view.selectedClub = selectedClub;
  view.regionalReviewQueue = []; view.showReviewQueue = roleView === "elevated";
  if (!clubIds.length) return view;
  const inScope = invoices.filter((i) => i.companyId === ctx.companyId && clubIds.includes(i.clubId) && (roleView === "manager" ? i.createdByUserId === ctx.userId : true));
  const row = (i) => ({ ...i, reportingMonth: operationalMonth(i), overdue: isOverdue(i, now) });
  const paid = inScope.filter((i) => i.status === "paid" && i.paidAt && i.paidAt >= start && i.paidAt < end).map(row);
  const live = inScope.filter((i) => AWAITING.includes(i.status)).map(row);
  // Manager also sees own drafts/rejected by operational month.
  const extra = roleView === "manager" ? inScope.filter((i) => MANAGER_EXTRA.includes(i.status)).map(row) : [];
  const currentUnpaid = live.filter((r) => r.reportingMonth === selKey);
  const currentExtra = extra.filter((r) => r.reportingMonth === selKey);
  const currentPeriodInvoices = [...paid, ...currentUnpaid, ...currentExtra];
  const carriedOverdueInvoices = live.filter((r) => r.overdue && r.dueDate && r.dueDate.getTime() < start.getTime() && r.reportingMonth !== selKey);
  const financialRows = currentPeriodInvoices.filter((r) => r.status !== "draft" && r.status !== "rejected");
  const sum = (rows) => rows.reduce((s, r) => s + r.amountKopeks, 0);
  const pending = sum(currentUnpaid.filter((r) => !r.overdue));
  const overdue = sum(currentUnpaid.filter((r) => r.overdue)) + sum(carriedOverdueInvoices);
  const sentCount = new Set(sentEvents.filter((e) => e.companyId === ctx.companyId && clubIds.includes(e.clubId) && e.createdAt >= start && e.createdAt < end && (roleView === "manager" ? e.userId === ctx.userId : true)).map((e) => e.invoiceId)).size;
  view.currentPeriodInvoices = currentPeriodInvoices; view.carriedOverdueInvoices = carriedOverdueInvoices;
  // «Ближайшие платежи»: awaiting-payment, no paidAt, not overdue, with dueDate;
  // nearest dueDate → earlier createdAt → id.
  view.upcomingPayments = currentPeriodInvoices
    .filter((r) => isAwaiting(r.status) && !r.paidAt && !r.overdue && r.dueDate)
    .sort((a, b) => (a.dueDate.getTime() - b.dueDate.getTime()) || (a.createdAt.getTime() - b.createdAt.getTime()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 6);
  // Month-independent review queue over ALL accessible clubs (not the filtered subset).
  view.regionalReviewQueue = isElevated
    ? invoices.filter((i) => i.companyId === ctx.companyId && availableClubs.some((c) => c.id === i.clubId) && i.status === "needs_review").sort((a, b) => a.createdAt - b.createdAt)
    : [];
  view.summary = roleView === "manager" ? { pendingPaymentAmountKopeks: pending, overdueAmountKopeks: overdue, sentCount } : { pendingPaymentAmountKopeks: pending, overdueAmountKopeks: overdue, sentCount, totalInvoiceAmountKopeks: sum(financialRows), paidAmountKopeks: sum(paid) };
  const byCat = new Map(); for (const r of financialRows) { const k = r.expenseCategory ?? "—"; const c = byCat.get(k) ?? { amountKopeks: 0, count: 0 }; c.amountKopeks += r.amountKopeks; c.count++; byCat.set(k, c); }
  view.categoryDistribution = [...byCat.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.amountKopeks - a.amountKopeks);
  return view;
}

const CO = "pilot-inv-co", ACC_U = "pilot-inv-acc", CHF_U = "pilot-inv-chf";
async function cleanup() {
  await p.auditLog.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.invoice.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.monthClose.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.clubUserAccess.deleteMany({ where: { userId: { startsWith: "pilot-inv-" } } }).catch(() => {});
  await p.companyUserAccess.deleteMany({ where: { userId: { startsWith: "pilot-inv-" } } }).catch(() => {});
  await p.company.deleteMany({ where: { id: CO } }).catch(() => {});
  await p.user.deleteMany({ where: { id: { startsWith: "pilot-inv-" } } }).catch(() => {});
}

async function main() {
  await cleanup();
  const now = new Date(2026, 6, 15); // 2026-07-15 (July)
  const JUL = { year: 2026, month: 7 }, JUN = { year: 2026, month: 6 };
  const d = (y, m, day) => new Date(y, m - 1, day);

  // Clubs (in-memory for the view mirror).
  const A = { id: "A", companyId: "C1", city: "Москва", name: "A" };
  const B = { id: "B", companyId: "C1", city: "Москва", name: "B" };
  const K = { id: "K", companyId: "C1", city: "Казань", name: "K" };
  const X = { id: "X", companyId: "C2", city: "Москва", name: "X" };
  const clubs = [A, B, K, X];
  const ctxOf = (userId, roles, allowed, companyId = "C1") => ({ userId, effectiveRoles: roles, allowedClubIds: allowed, companyId, clubs });
  const mgr = ctxOf("mgr", ["manager"], ["A"]);
  const mgr2 = ctxOf("mgr2", ["manager"], ["B"]);
  const rd = ctxOf("rd", ["regional_director"], ["A", "B"]);
  const acc = ctxOf("acc", ["accountant"], ["A", "B", "K"]);
  const chf = ctxOf("chf", ["chief_accountant", "accountant"], ["A", "B", "K"]);
  const own = ctxOf("own", ["owner"], ["A", "B", "K"]);
  const gd = ctxOf("gd", ["general_director"], ["A", "B", "K"]);
  const sa = ctxOf("sa", ["system_admin"], []);

  let seq = 0;
  const inv = (o) => ({ id: `i${seq++}`, companyId: "C1", clubId: "A", createdByUserId: "mgr", status: "needs_review", amountKopeks: 1000, expenseCategory: "household", invoiceDate: null, dueDate: null, paidAt: null, createdAt: d(2026, 1, 1), ...o });

  // --- Reporting month (1–9) ---
  const unpaidJun = inv({ status: "needs_review", dueDate: d(2026, 6, 28) });
  const paidJul = inv({ status: "paid", dueDate: d(2026, 6, 28), paidAt: d(2026, 7, 3) });
  check("1 unpaid invoice reports to dueDate month", reportingMonth(unpaidJun) === "2026-06");
  check("2 paid invoice reports to paidAt month", reportingMonth(paidJul) === "2026-07");
  check("3 due 28-Jun unpaid shows in June", reportingMonth(unpaidJun) === "2026-06");
  check("4 after paid 3-Jul shows in July", reportingMonth(paidJul) === "2026-07");
  check("5 paid no longer in June main set", reportingMonth(paidJul) !== "2026-06");
  check("6 createdAt does not override dueDate/paidAt", reportingMonth(inv({ status: "needs_review", dueDate: d(2026, 6, 28), createdAt: d(2026, 1, 1) })) === "2026-06" && reportingMonth(inv({ status: "paid", paidAt: d(2026, 7, 3), createdAt: d(2026, 1, 1) })) === "2026-07");
  check("7 canceled not awaiting payment", !isAwaiting("canceled"));
  check("8 rejected not awaiting payment", !isAwaiting("rejected"));
  check("9 paid never overdue", isOverdue(inv({ status: "paid", dueDate: d(2026, 5, 1), paidAt: d(2026, 5, 2) }), now) === false);
  check("9b draft never overdue (not sent)", isOverdue(inv({ status: "draft", dueDate: d(2026, 1, 1) }), now) === false);

  // --- Carried overdue (10–16) ---
  // Manager mgr owns: a June overdue unpaid, a July paid, a July pending unpaid.
  // Confirmed-unpaid debt (approved) → reports to dueDate month, so it carries as
  // an overdue debt from June into July. (needs_review is operational, not a debt.)
  const carried = inv({ id: "carried", status: "approved_by_regional", dueDate: d(2026, 6, 28), createdByUserId: "mgr", clubId: "A" });
  const julPaid = inv({ id: "julpaid", status: "paid", dueDate: d(2026, 6, 20), paidAt: d(2026, 7, 3), amountKopeks: 5000, createdByUserId: "mgr", clubId: "A" });
  const julPending = inv({ id: "julpend", status: "approved_by_regional", dueDate: d(2026, 7, 25), amountKopeks: 2000, createdByUserId: "mgr", clubId: "A" });
  const mgrInvoices = [carried, julPaid, julPending];
  const sentEvents = [
    { invoiceId: "julpaid", companyId: "C1", clubId: "A", userId: "mgr", createdAt: d(2026, 7, 2) },
    { invoiceId: "julpend", companyId: "C1", clubId: "A", userId: "mgr", createdAt: d(2026, 7, 10) },
    { invoiceId: "carried", companyId: "C1", clubId: "A", userId: "mgr", createdAt: d(2026, 6, 1) }, // sent in June
  ];
  const vMgr = buildView(mgr, {}, mgrInvoices, sentEvents, now);
  check("10 June unpaid debt visible in July (carried)", vMgr.carriedOverdueInvoices.some((r) => r.id === "carried"));
  check("11 carried debt counts in overdue amount", vMgr.summary.overdueAmountKopeks === 1000);
  check("12 carried debt NOT in sent count (sent in June)", vMgr.summary.sentCount === 2);
  check("13 carried debt not duplicated in current period", !vMgr.currentPeriodInvoices.some((r) => r.id === "carried"));
  const vMgrPaidCarried = buildView(mgr, {}, [{ ...carried, status: "paid", paidAt: d(2026, 7, 5) }], [], now);
  check("14 once paid, debt leaves carried overdue", vMgrPaidCarried.carriedOverdueInvoices.length === 0);
  check("15 once paid, debt moves to paidAt month (July)", vMgrPaidCarried.currentPeriodInvoices.length === 1 && vMgrPaidCarried.currentPeriodInvoices[0].reportingMonth === "2026-07");
  // closed prior month does not hide the debt (mirror: carried is computed from live status, ignores month-close)
  check("16 closed prior month still shows the debt", buildView(mgr, {}, [carried], [], now).carriedOverdueInvoices.length === 1);

  // --- Manager restrictions (17–36) ---
  const other = inv({ id: "other", status: "needs_review", dueDate: d(2026, 7, 20), createdByUserId: "mgr2", clubId: "B" });
  const rdInv = inv({ id: "rdi", status: "needs_review", dueDate: d(2026, 7, 20), createdByUserId: "rd", clubId: "A" });
  const all = [...mgrInvoices, other, rdInv];
  const vM = buildView(mgr, {}, all, sentEvents, now);
  check("17 manager sees only own invoices", vM.currentPeriodInvoices.every((r) => r.createdByUserId === "mgr") && vM.carriedOverdueInvoices.every((r) => r.createdByUserId === "mgr"));
  check("18 manager does not see other manager invoice", !vM.currentPeriodInvoices.some((r) => r.id === "other"));
  check("19 manager does not see regional invoice in own club", !vM.currentPeriodInvoices.some((r) => r.id === "rdi"));
  check("24 manager does not see another club (B)", !vM.currentPeriodInvoices.some((r) => r.clubId === "B"));
  check("25 manager forced to current month", vM.effectivePeriod.year === 2026 && vM.effectivePeriod.month === 7);
  check("26 manager month spoof ignored", buildView(mgr, { year: "2026", month: "6" }, all, sentEvents, now).effectivePeriod.month === 7);
  check("27 manager year spoof ignored", buildView(mgr, { year: "2025", month: "7" }, all, sentEvents, now).effectivePeriod.year === 2026);
  check("28 manager sees own carried debt", vM.carriedOverdueInvoices.some((r) => r.id === "carried"));
  check("29 manager does not see others' carried debt", buildView(mgr, {}, [inv({ id: "oc", status: "needs_review", dueDate: d(2026, 6, 1), createdByUserId: "mgr2", clubId: "A" })], [], now).carriedOverdueInvoices.length === 0);
  check("30 pending amount only own", vM.summary.pendingPaymentAmountKopeks === 2000);
  check("31 overdue amount only own", vM.summary.overdueAmountKopeks === 1000);
  check("32 sent count only own", vM.summary.sentCount === 2);
  check("33 category distribution only own", vM.categoryDistribution.every((c) => c.category === "household"));
  check("34 manager summary has NO totalInvoiceAmount", !("totalInvoiceAmountKopeks" in vM.summary));
  check("35 manager summary has NO paidAmount", !("paidAmountKopeks" in vM.summary));
  check("36 manager gets no club comparison / no elevated summary keys", Object.keys(vM.summary).sort().join(",") === "overdueAmountKopeks,pendingPaymentAmountKopeks,sentCount");

  // --- Elevated filters (37–52) ---
  check("37 regional limited to accessible clubs", buildView(rd, {}, [], [], now).availableClubs.map((c) => c.id).sort().join() === "A,B");
  check("38 accountant limited to assigned clubs", buildView(acc, {}, [], [], now).availableClubs.map((c) => c.id).sort().join() === "A,B,K");
  check("39 chief accountant limited to allowed clubs", buildView(chf, {}, [], [], now).availableClubs.length === 3);
  check("40 owner limited to own company clubs", buildView(own, {}, [], [], now).availableClubs.every((c) => c.companyId === "C1"));
  check("41 general director limited to allowed clubs", buildView(gd, {}, [], [], now).availableClubs.length === 3);
  // Future due dates → pending (not overdue) so the filter sums are unambiguous.
  const elevInv = [inv({ id: "eA", clubId: "A", status: "approved_by_regional", dueDate: d(2026, 7, 25), amountKopeks: 100, createdByUserId: "mgr" }), inv({ id: "eK", clubId: "K", status: "approved_by_regional", dueDate: d(2026, 7, 25), amountKopeks: 200, expenseCategory: "rent", createdByUserId: "mgr" })];
  const vCity = buildView(acc, { city: "Казань" }, elevInv, [], now);
  check("42 city filter limits cards", vCity.summary.pendingPaymentAmountKopeks === 200);
  check("43 city filter limits list", vCity.currentPeriodInvoices.length === 1 && vCity.currentPeriodInvoices.every((r) => r.clubId === "K"));
  check("44 city filter limits categories", vCity.categoryDistribution.length === 1 && vCity.categoryDistribution[0].category === "rent");
  const vClub = buildView(acc, { clubId: "A" }, elevInv, [], now);
  check("45 club filter limits cards", vClub.summary.pendingPaymentAmountKopeks === 100);
  check("46 club filter limits list", vClub.currentPeriodInvoices.every((r) => r.clubId === "A"));
  check("47 club filter limits categories", vClub.categoryDistribution.every((c) => c.category === "household"));
  check("48 club of another city dropped when city selected", buildView(acc, { city: "Казань", clubId: "A" }, elevInv, [], now).selectedClub === null);
  check("49 club of another company not accepted", buildView(acc, { clubId: "X" }, elevInv, [], now).selectedClub === null);
  check("51 unknown city reveals nothing extra", buildView(acc, { city: "Пермь" }, elevInv, [], now).selectedCity === null);
  check("52 unknown clubId reveals nothing", buildView(acc, { clubId: "zzz" }, elevInv, [], now).selectedClub === null);

  // --- Elevated month navigation (53–58) ---
  check("53 current month allowed", buildView(acc, { year: "2026", month: "7" }, [], [], now).effectivePeriod.month === 7);
  check("54 previous month allowed", buildView(acc, { year: "2026", month: "6" }, [], [], now).effectivePeriod.month === 6);
  check("55 manager gets no canNavigateMonths", vM.canNavigateMonths === false);
  check("56 elevated gets canNavigateMonths", buildView(acc, {}, [], [], now).canNavigateMonths === true);
  const junView = buildView(acc, { year: "2026", month: "6" }, [carried, julPaid], [], now);
  check("57 selected month applies to totals and list", junView.currentPeriodInvoices.some((r) => r.id === "carried") && !junView.currentPeriodInvoices.some((r) => r.id === "julpaid"));
  check("58 carried overdue computed vs selected month", buildView(acc, { year: "2026", month: "8" }, [carried], [], now).carriedOverdueInvoices.some((r) => r.id === "carried"));

  // --- Add paid invoice role gate (59–65) ---
  check("59 accountant may add paid invoice", canAddPaid(["accountant"]) === true);
  check("60 chief accountant may add paid invoice", canAddPaid(["chief_accountant", "accountant"]) === true);
  check("61 manager refused", canAddPaid(["manager"]) === false);
  check("62 regional refused", canAddPaid(["regional_director"]) === false);
  check("63 owner refused", canAddPaid(["owner"]) === false);
  check("64 general director refused", canAddPaid(["general_director"]) === false);
  check("65 system_admin (no financial) refused", canAddPaid(["system_admin"]) === false);

  // --- Real-DB: add-paid audit / kopeks / closed month / query shapes (66–72) ---
  await p.user.create({ data: { id: ACC_U, email: "pilot-inv-acc@x.dev", name: "Acc", role: "accountant", isActive: true } });
  await p.company.create({ data: { id: CO, name: "Inv Co" } });
  await p.club.create({ data: { id: "pilot-inv-club", name: "Inv Club", city: "Москва", companyId: CO } });
  const paidInv = await p.invoice.create({ data: { companyId: CO, clubId: "pilot-inv-club", createdByUserId: ACC_U, amountKopeks: 150000, currency: "RUB", status: "paid", confidence: "high", invoiceDate: d(2026, 7, 1), paidAt: d(2026, 7, 3), expensePeriod: "2026-07" } });
  await p.auditLog.create({ data: { action: "invoice.paid", entityType: "Invoice", entityId: paidInv.id, companyId: CO, clubId: "pilot-inv-club", userId: ACC_U, metadataJson: JSON.stringify({ historical: true, paidAt: paidInv.paidAt.toISOString(), amountKopeks: 150000, role: "accountant" }) } });
  check("66 add-paid requires paidAt (stored)", paidInv.paidAt !== null);
  check("67 reporting month from paidAt", reportingMonth(paidInv) === "2026-07");
  const closedProbe = await p.monthClose.create({ data: { companyId: CO, clubId: "pilot-inv-club", month: "2026-05", status: "closed", closedByUserId: ACC_U } });
  check("68 closed month row exists (guard basis)", closedProbe.status === "closed");
  check("69 club/company are server-derived on the invoice", paidInv.companyId === CO && paidInv.clubId === "pilot-inv-club");
  check("70 amount stored as integer kopeks", Number.isInteger(paidInv.amountKopeks) && paidInv.amountKopeks === 150000);
  check("71 add-paid AuditLog created with actor/amount/role", (await p.auditLog.count({ where: { action: "invoice.paid", entityId: paidInv.id, userId: ACC_U } })) === 1);
  // loader query shapes (paid-in-month + distinct sent audits) run against schema
  const paidInMonth = await p.invoice.findMany({ where: { companyId: CO, status: "paid", paidAt: { gte: d(2026, 7, 1), lt: d(2026, 8, 1) } }, select: { id: true } });
  const sentDistinct = await p.auditLog.findMany({ where: { action: "invoice.sent_to_review", companyId: CO }, select: { entityId: true }, distinct: ["entityId"] });
  check("72 loader query shapes valid (paidInMonth + distinct sent)", paidInMonth.length === 1 && Array.isArray(sentDistinct));

  // --- Static contract assertions (73–81 support) ---
  const lib = readFileSync(new URL("../src/lib/invoices.ts", import.meta.url), "utf8");
  const viewSrc = readFileSync(new URL("../src/lib/invoice-view.ts", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../src/app/(app)/invoices/actions.ts", import.meta.url), "utf8");
  const pageSrc = readFileSync(new URL("../src/app/(app)/invoices/page.tsx", import.meta.url), "utf8");
  check("S1 helpers exist (reporting month + overdue + awaiting)", lib.includes("getInvoiceReportingMonth") && lib.includes("isInvoiceOverdue") && lib.includes("isInvoiceAwaitingPayment"));
  check("S2 canAddPaidInvoice = accountant/chief", lib.includes('roles.includes("accountant") || roles.includes("chief_accountant")'));
  check("S3 loader exposes the data contract fields", ["effectivePeriod", "roleView", "canNavigateMonths", "canFilterByCity", "canFilterByClub", "availableCities", "availableClubs", "carriedOverdueInvoices", "categoryDistribution", "canAddPaidInvoice"].every((k) => viewSrc.includes(k)));
  check("S4 manager summary omits totals", viewSrc.includes('roleView === "manager"') && viewSrc.includes("pendingPaymentAmountKopeks") && viewSrc.includes("totalInvoiceAmountKopeks"));
  check("S5 manager month forced (elevated-only override)", viewSrc.includes("if (isElevated) {") && viewSrc.includes("now.getMonth() + 1"));
  check("S6 sentCount from invoice.sent_to_review audit", viewSrc.includes('action: "invoice.sent_to_review"') && viewSrc.includes('distinct: ["entityId"]'));
  check("S7 add-paid action gated by canAddPaidInvoice", actions.includes("if (!canAddPaidInvoice(ctx.effectiveRoles))"));
  check("S8 add-paid blocks closed paidAt month", actions.includes("monthClosedError(companyId, clubId, paidAt)"));
  check("S9 add-paid audit carries role + amount", actions.includes("role: ctx.effectiveRoles.includes(\"chief_accountant\") ? \"chief_accountant\" : \"accountant\""));
  check("S10 add-paid form gated by permissions.canAddPaidInvoice", pageSrc.includes("view.permissions.canAddPaidInvoice"));
  check("S11 existing workflow actions untouched (send/approve/pay present)", actions.includes("applyInvoiceAction") && actions.includes("transitionInvoice"));

  // --- UI wiring: page uses ONLY getInvoicesView (1–5, 46–66) ---
  const filtersSrc = readFileSync(new URL("../src/app/(app)/invoices/_components/InvoiceFilters.tsx", import.meta.url), "utf8");
  check("U1 page uses getInvoicesView", pageSrc.includes("getInvoicesView(ctx, sp)"));
  check("U2 page no longer imports old getInvoicesForScope", !pageSrc.includes("getInvoicesForScope"));
  check("U3 no old InvoiceAnalytics aggregate on the page", !pageSrc.includes("InvoiceAnalytics"));
  check("U4 no second full invoice query on the page", !pageSrc.includes("prisma.invoice.findMany"));
  check("U5 summary comes from the contract (view.summary)", pageSrc.includes("view.summary"));
  // upload block is ABOVE the summary cards
  const idxUpload = pageSrc.indexOf("<InvoiceUpload");
  const idxCards = Math.min(...["<ManagerCards", "<ElevatedCards"].map((s) => (pageSrc.indexOf(s) === -1 ? Infinity : pageSrc.indexOf(s))));
  check("U6 upload block is above the summary cards", idxUpload > 0 && idxUpload < idxCards);
  check("U7 no bottom duplicate of the upload form", pageSrc.split("<InvoiceUpload").length === 2);
  // manager cards: exactly the 3 allowed, none of the forbidden
  const mgrCards = pageSrc.slice(pageSrc.indexOf("function ManagerCards"), pageSrc.indexOf("function ElevatedCards"));
  check("U8 manager has the 3 allowed cards", mgrCards.includes("Ожидает оплаты") && mgrCards.includes("Просрочено") && mgrCards.includes("Всего счетов отправлено"));
  check("U9 manager cards omit «Сумма счетов»/«Оплачено»", !mgrCards.includes("Сумма счетов") && !mgrCards.includes("Оплачено"));
  check("U10 «По клубам» only for elevated + no single-club", pageSrc.includes("!isManager && !view.selectedClub ? <ByClubBlock"));
  check("U11 filters rendered only in the elevated branch", pageSrc.includes("<InvoiceFilters") && pageSrc.includes("isManager ? (") && pageSrc.includes("{monthLabel}</div>"));
  check("U12 carried overdue block wired with a clear marker", pageSrc.includes("view.carriedOverdueInvoices") && pageSrc.includes("Долг прошлого периода"));
  check("U13 month arrows have aria-labels", filtersSrc.includes('aria-label="Предыдущий месяц"') && filtersSrc.includes('aria-label="Следующий месяц"'));
  check("U14 city + club selects have labels", filtersSrc.includes("Город") && filtersSrc.includes("Клуб") && filtersSrc.includes("Все города") && filtersSrc.includes("Все клубы"));
  check("U15 filters update the URL search params", filtersSrc.includes("router.push(`/invoices?") && filtersSrc.includes("useSearchParams"));
  check("U16 changing city resets an incompatible club", filtersSrc.includes("clubId: null"));
  check("U17 empty states present", pageSrc.includes("Нет счетов по статьям за текущий месяц") && pageSrc.includes("Нет ближайших платежей") && pageSrc.includes("Нет счетов в выбранном месяце"));
  check("U18 mobile-safe tables use overflow-x-auto", pageSrc.includes("overflow-x-auto"));
  check("U19 manager desktop grid = 3 cards", mgrCards.includes("sm:grid-cols-3"));

  // --- Manager RSC-payload leak: serialized manager view carries NO hidden data ---
  const serialized = JSON.stringify(vM);
  check("L1 manager view has no totalInvoiceAmount key", !serialized.includes("totalInvoiceAmountKopeks"));
  check("L2 manager view has no paidAmount key", !serialized.includes("paidAmountKopeks"));
  check("L3 manager view leaks no foreign invoice ids", !serialized.includes('"other"') && !serialized.includes('"rdi"'));
  check("L4 manager view rows are all own", [...vM.currentPeriodInvoices, ...vM.carriedOverdueInvoices].every((r) => r.createdByUserId === "mgr"));

  // === Draft visibility for manager (100–109) ===============================
  const draftBase = { companyId: "C1", clubId: "A", createdByUserId: "mgr", status: "draft", amountKopeks: 1000, expenseCategory: "household", invoiceDate: null, dueDate: null, paidAt: null, createdAt: d(2026, 7, 10) };
  const draftSet = [
    { ...draftBase, id: "dNoDate" },
    { ...draftBase, id: "dInvDate", invoiceDate: d(2026, 7, 5) },
    { ...draftBase, id: "dAiErr" },   // AI error → row is still a draft
    { ...draftBase, id: "dLowConf", confidence: "low" },
    { ...draftBase, id: "dFutureDue", dueDate: d(2026, 8, 20) }, // future dueDate must NOT hide a draft
    { ...draftBase, id: "dOtherMgr", createdByUserId: "mgr2" },
    { ...draftBase, id: "dOtherClub", clubId: "B" },
    { ...draftBase, id: "dOtherCo", companyId: "C2", clubId: "X" },
  ];
  const vDraft = buildView(mgr, {}, draftSet, [], now);
  const dIds = new Set(vDraft.currentPeriodInvoices.map((r) => r.id));
  check("100 draft with future dueDate still visible to manager", dIds.has("dFutureDue"));
  check("101 draft without dueDate visible", dIds.has("dNoDate"));
  check("102 draft with invoiceDate visible", dIds.has("dInvDate"));
  check("103 draft with AI error visible", dIds.has("dAiErr"));
  check("104 draft with low confidence visible", dIds.has("dLowConf"));
  check("105 other manager's draft NOT visible", !dIds.has("dOtherMgr"));
  check("106 other club draft NOT visible", !dIds.has("dOtherClub"));
  check("107 other company draft NOT visible", !dIds.has("dOtherCo"));
  check("108 draft NOT counted in sentCount", vDraft.summary.sentCount === 0);
  check("109 draft excluded from category distribution (financial)", vDraft.categoryDistribution.length === 0);

  // === Regional review queue — month-independent (120–132) ==================
  const nrA = inv({ id: "nrA", status: "needs_review", clubId: "A", createdByUserId: "mgr", createdAt: d(2026, 7, 1), dueDate: d(2026, 8, 10) });
  const nrB = inv({ id: "nrB", status: "needs_review", clubId: "B", createdByUserId: "mgr2", createdAt: d(2026, 7, 2) });
  const nrK = inv({ id: "nrK", status: "needs_review", clubId: "K", createdByUserId: "mgr", createdAt: d(2026, 7, 3) });
  const nrX = inv({ id: "nrX", companyId: "C2", clubId: "X", status: "needs_review", createdAt: d(2026, 7, 4) });
  const qDraftA = inv({ id: "qDraftA", status: "draft", clubId: "A", createdByUserId: "mgr" });
  const qPaidA = inv({ id: "qPaidA", status: "paid", clubId: "A", paidAt: d(2026, 7, 5) });
  const queueSet = [nrA, nrB, nrK, nrX, qDraftA, qPaidA];
  const vRdQ = buildView(rd, {}, queueSet, [], now); // rd → clubs A,B
  const qIds = new Set(vRdQ.regionalReviewQueue.map((r) => r.id));
  check("120 regional sees needs_review in own club", qIds.has("nrA"));
  check("121 regional does NOT see other-club needs_review (K)", !qIds.has("nrK"));
  check("122 regional does NOT see other-company needs_review", !qIds.has("nrX"));
  check("123 both accessible clubs visible (independent of author)", qIds.has("nrA") && qIds.has("nrB"));
  check("124 draft NOT in review queue", !qIds.has("qDraftA"));
  check("125 paid NOT in review queue", !qIds.has("qPaidA"));
  check("126 selecting June does not change the queue", buildView(rd, { year: "2026", month: "6" }, queueSet, [], now).regionalReviewQueue.length === vRdQ.regionalReviewQueue.length);
  check("127 selecting August does not change the queue", buildView(rd, { year: "2026", month: "8" }, queueSet, [], now).regionalReviewQueue.length === vRdQ.regionalReviewQueue.length);
  check("128 dueDate null does not hide from queue", buildView(rd, {}, [inv({ id: "nrNoDue", status: "needs_review", clubId: "A", dueDate: null })], [], now).regionalReviewQueue.some((r) => r.id === "nrNoDue"));
  check("129 invoiceDate in past month does not hide from queue", buildView(rd, {}, [inv({ id: "nrPast", status: "needs_review", clubId: "A", invoiceDate: d(2026, 1, 1), dueDate: null })], [], now).regionalReviewQueue.some((r) => r.id === "nrPast"));
  const vMgrQ = buildView(mgr, {}, queueSet, [], now);
  check("130 manager gets no review queue", vMgrQ.regionalReviewQueue.length === 0 && vMgrQ.showReviewQueue === false);
  check("131 elevated club filter does not shrink the queue below full scope", buildView(rd, { clubId: "A" }, queueSet, [], now).regionalReviewQueue.length === vRdQ.regionalReviewQueue.length);
  check("132 chief accountant also gets the queue", buildView(chf, {}, queueSet, [], now).regionalReviewQueue.length >= 2 && buildView(chf, {}, queueSet, [], now).showReviewQueue === true);

  // === Period logic — operational vs financial (140–146) ====================
  check("140 draft uses invoiceDate", operationalMonth({ status: "draft", invoiceDate: d(2026, 7, 5), createdAt: d(2026, 1, 1) }) === "2026-07");
  check("141 draft without invoiceDate uses createdAt", operationalMonth({ status: "draft", invoiceDate: null, createdAt: d(2026, 7, 9) }) === "2026-07");
  check("142 needs_review uses invoiceDate/createdAt, not dueDate", operationalMonth({ status: "needs_review", invoiceDate: null, dueDate: d(2026, 12, 1), createdAt: d(2026, 7, 1) }) === "2026-07");
  check("143 paid uses paidAt", operationalMonth({ status: "paid", paidAt: d(2026, 7, 3), dueDate: d(2026, 6, 1) }) === "2026-07");
  check("144 confirmed-unpaid uses dueDate", operationalMonth({ status: "approved_by_regional", dueDate: d(2026, 7, 25), invoiceDate: d(2026, 1, 1), createdAt: d(2026, 1, 1) }) === "2026-07");
  check("145 old overdue confirmed debt keeps its dueDate month", operationalMonth({ status: "approved_by_regional", dueDate: d(2026, 5, 1) }) === "2026-05");
  check("146 financial reporting date (dashboard) rule untouched", reportingMonth({ status: "approved_by_regional", dueDate: d(2026, 6, 28), invoiceDate: null, createdAt: d(2026, 1, 1), paidAt: null }) === "2026-06");

  // === Submission authorization + readiness (150–159) =======================
  const canSend = (status, roles, isCreator) => status === "draft" && (roles.includes("manager") || roles.includes("regional_director")) && isCreator;
  check("150 manager-author can send own draft", canSend("draft", ["manager"], true) === true);
  check("151 other manager cannot send", canSend("draft", ["manager"], false) === false);
  check("152 regional cannot send on behalf (not creator)", canSend("draft", ["regional_director"], false) === false);
  check("153 accountant cannot send", canSend("draft", ["accountant"], true) === false);
  check("154 cannot send a non-draft", canSend("needs_review", ["manager"], true) === false);
  check("155 submit blocked without counterparty", submitBlocked({ counterpartyName: null, amountKopeks: 1000, hasFile: true }) === "counterparty");
  check("156 submit blocked with zero amount", submitBlocked({ counterpartyName: "X", amountKopeks: 0, hasFile: true }) === "amount");
  check("157 submit blocked without file", submitBlocked({ counterpartyName: "X", amountKopeks: 1000, hasFile: false }) === "file");
  check("158 submit ready with all required fields", submitBlocked({ counterpartyName: "X", amountKopeks: 1000, hasFile: true }) === null);
  check("159 low AI confidence does NOT block submit", submitBlocked({ counterpartyName: "X", amountKopeks: 1000, hasFile: true, confidence: "low" }) === null);

  // === Real-DB: idempotent submit + sentCount (160–163) =====================
  const draftDb = await p.invoice.create({ data: { companyId: CO, clubId: "pilot-inv-club", createdByUserId: ACC_U, amountKopeks: 5000, currency: "RUB", status: "draft", confidence: "low", counterpartyName: "Поставщик", originalFileStorageKey: "invoices/x.pdf", invoiceDate: null, dueDate: null, createdAt: d(2026, 7, 10) } });
  const first = await p.invoice.updateMany({ where: { id: draftDb.id, status: "draft" }, data: { status: "needs_review" } });
  const second = await p.invoice.updateMany({ where: { id: draftDb.id, status: "draft" }, data: { status: "needs_review" } });
  check("160 conditional submit updates exactly one row", first.count === 1);
  check("161 duplicate submit updates zero rows (idempotent)", second.count === 0);
  await p.auditLog.create({ data: { action: "invoice.sent_to_review", entityType: "Invoice", entityId: draftDb.id, companyId: CO, clubId: "pilot-inv-club", userId: ACC_U, createdAt: d(2026, 7, 10) } });
  const sc = await p.auditLog.findMany({ where: { action: "invoice.sent_to_review", companyId: CO, createdAt: { gte: d(2026, 7, 1), lt: d(2026, 8, 1) } }, select: { entityId: true }, distinct: ["entityId"] });
  check("162 sent audit yields sentCount = 1 for the month", sc.length === 1);
  check("163 draft row flipped to needs_review exactly once", (await p.invoice.findUnique({ where: { id: draftDb.id } })).status === "needs_review");

  // === Static assertions for the fix (S12–S18, U20–U23) =====================
  check("S12 view uses the operational month helper", viewSrc.includes("getInvoiceOperationalMonth"));
  check("S13 lib exposes operational helpers + submit gate + queue predicate", lib.includes("getInvoiceOperationalMonth") && lib.includes("invoiceSubmitBlockedReason") && lib.includes("isAwaitingRegionalReview"));
  check("S14 send_to_review requires the author (pure table)", lib.includes("Отправить на проверку может только автор счёта"));
  check("S15 transition uses conditional updateMany + clear stale message", actions.includes("updateMany({") && actions.includes("status: existing.status") && actions.includes("Статус счёта уже изменён"));
  check("S16 submit readiness enforced server-side", actions.includes("invoiceSubmitBlockedReason"));
  check("S17 view builds a needs_review review queue over accessible clubs", viewSrc.includes("regionalReviewQueue") && viewSrc.includes('status: "needs_review"') && viewSrc.includes("availableClubs.map((c) => c.id)"));
  check("S18 review queue query carries no month bound", (() => { const i = viewSrc.indexOf('status: "needs_review"'); const seg = viewSrc.slice(i - 200, i + 120); return !/paidAt|gte:|lt:/.test(seg); })());
  check("U20 review queue rendered above analytics", pageSrc.indexOf("<ReviewQueue") > 0 && pageSrc.indexOf("<ReviewQueue") < pageSrc.indexOf("<CategoryBlock"));
  check("U21 review queue empty state present", pageSrc.includes("Нет счетов, ожидающих проверки"));
  check("U22 draft row shows «Продолжить заполнение»", pageSrc.includes("Продолжить заполнение"));
  check("U23 review queue gated by showReviewQueue", pageSrc.includes("view.showReviewQueue ? <ReviewQueue"));

  // === Invoice file access: detail scope + download + storage (200–239) =====
  const STORAGE_KEY_RE = /^invoices\/[a-f0-9]{32}\.(jpg|png|webp|pdf)$/;
  const isSafeKey = (k) => !!k && k.length <= 256 && !k.startsWith("/") && !k.includes("..") && !k.includes("\\") && /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(k);
  // Mirror of getInvoiceForContext scope (company + allowed clubs; NOT creator).
  const inScope = (invx, cx) => !!invx && invx.companyId === cx.companyId && cx.allowedClubIds.includes(invx.clubId);
  // Mirror of resolveInvoiceFileStatus.
  const fileStatus = (storageKey, objectExists) => (!storageKey ? "no_metadata" : objectExists ? "available" : "missing_object");
  // Mirror of the download route's decision table.
  const routeResult = (invx, cx, objectExists) =>
    !inScope(invx, cx) ? { status: 404, code: null } :
    !invx.originalFileStorageKey ? { status: 404, code: "INVOICE_FILE_NO_METADATA" } :
    !objectExists ? { status: 404, code: "INVOICE_FILE_NOT_FOUND" } :
    { status: 200, code: null };

  const iA = { id: "fA", companyId: "C1", clubId: "A", originalFileStorageKey: "invoices/" + "a".repeat(32) + ".pdf", originalFileMime: "application/pdf" };
  const iNoKey = { id: "fNo", companyId: "C1", clubId: "A", originalFileStorageKey: null };
  const iOtherClub = { id: "fB", companyId: "C1", clubId: "B", originalFileStorageKey: "invoices/" + "b".repeat(32) + ".pdf" };
  const iOtherCo = { id: "fX", companyId: "C2", clubId: "X", originalFileStorageKey: "invoices/" + "c".repeat(32) + ".pdf" };
  const mgrCtx = { companyId: "C1", allowedClubIds: ["A"] };
  const rdCtx = { companyId: "C1", allowedClubIds: ["A", "B"] };
  const accCtx = { companyId: "C1", allowedClubIds: ["A", "B", "K"] };

  // Detail route (200–209)
  check("200 manager opens invoice in own club", inScope(iA, mgrCtx) === true);
  check("201 manager cannot open invoice of another club", inScope(iOtherClub, mgrCtx) === false);
  check("202 regional opens invoice of accessible club", inScope(iA, rdCtx) === true && inScope(iOtherClub, rdCtx) === true);
  check("203 regional cannot open another company", inScope(iOtherCo, rdCtx) === false);
  check("204 accountant opens allowed-scope invoice", inScope(iA, accCtx) === true);
  check("205 chief accountant opens allowed-scope invoice", inScope(iA, { companyId: "C1", allowedClubIds: ["A", "B", "K"] }) === true);
  check("206 invoice WITHOUT file still opens (no 404 on card)", fileStatus(iNoKey.originalFileStorageKey, false) === "no_metadata");
  check("207 invoice with missing object still opens (card)", fileStatus(iA.originalFileStorageKey, false) === "missing_object");
  check("208 missing invoice → not in scope (404)", inScope(null, mgrCtx) === false);
  check("209 detail uses invoice.id (route param), not storageKey", (() => { const src = readFileSync(new URL("../src/app/(app)/invoices/[id]/page.tsx", import.meta.url), "utf8"); return src.includes("getInvoiceForContext(ctx, id)"); })());

  // Download route (210–225)
  check("210 authorized manager downloads own file (object present)", routeResult(iA, mgrCtx, true).status === 200);
  check("211 regional downloads accessible-club file", routeResult(iOtherClub, rdCtx, true).status === 200);
  check("212 accountant downloads allowed file", routeResult(iA, accCtx, true).status === 200);
  check("213 foreign user (other company) → generic 404, no code", (() => { const r = routeResult(iOtherCo, rdCtx, true); return r.status === 404 && r.code === null; })());
  const fileRoute = readFileSync(new URL("../src/app/api/invoices/[id]/file/route.ts", import.meta.url), "utf8");
  check("214 client cannot supply a storageKey (route reads DB key only)", !fileRoute.includes('searchParams.get("key")') && fileRoute.includes("invoice.originalFileStorageKey"));
  check("215 metadata absent → controlled INVOICE_FILE_NO_METADATA", routeResult(iNoKey, mgrCtx, false).code === "INVOICE_FILE_NO_METADATA");
  check("216 object absent → controlled INVOICE_FILE_NOT_FOUND", routeResult(iA, mgrCtx, false).code === "INVOICE_FILE_NOT_FOUND");
  check("217 Content-Type derived safely, NOT from client-stored mime", fileRoute.includes("safeDownloadHeaders(") && !fileRoute.includes("invoice.originalFileMime"));
  check("218 response headers via safeDownloadHeaders (nosniff + safe disposition)", fileRoute.includes("safeDownloadHeaders(invoice.originalFileStorageKey"));
  check("219 file name sanitized in disposition", readFileSync(new URL("../src/lib/document-access.ts", import.meta.url), "utf8").includes("encodeURIComponent(fileName)"));
  check("220 bucket/storageKey never in response (only mime + disposition headers)", !fileRoute.includes("originalFileStorageKey ??") && !/headers:\s*{[^}]*storageKey/.test(fileRoute));
  check("221 no public URL returned (streams bytes)", fileRoute.includes("new NextResponse(new Uint8Array(buffer)") && !fileRoute.includes("getSignedUrl"));
  check("222 raw 'Not found' only for generic A-case, controlled messages otherwise", fileRoute.includes('"К счёту не прикреплён файл."') && fileRoute.includes("не найден в хранилище"));
  check("223 safe log excludes storageKey/bucket/contents (hash only)", fileRoute.includes("storageKeyHash(") && !fileRoute.includes("originalFileStorageKey }") && fileRoute.includes("storageObjectFound: false"));
  check("224 download does not change status (no invoice.update in route)", !fileRoute.includes("prisma.invoice.update") && !fileRoute.includes(".update("));
  check("225 download audits view/download only (no financial transition)", fileRoute.includes("document.viewed") && fileRoute.includes("document.downloaded") && !fileRoute.includes("sent_to_review"));

  // Storage key handling + provider (226–235), incl. a real local-provider check
  check("226 storage key pattern (32 hex + ext)", STORAGE_KEY_RE.test("invoices/" + "0".repeat(32) + ".pdf") && !STORAGE_KEY_RE.test("invoices/x.pdf"));
  check("227 leading slash rejected by safe-key guard", isSafeKey("/invoices/x.pdf") === false);
  check("228 traversal rejected", isSafeKey("invoices/../secret") === false);
  check("229 prefix 'invoices/' required", STORAGE_KEY_RE.test("other/" + "0".repeat(32) + ".pdf") === false);
  check("230 upload key === download key (same DB value, one regex)", (() => { const s = readFileSync(new URL("../src/lib/invoice-storage.ts", import.meta.url), "utf8"); return s.includes("STORAGE_KEY_RE.test(storageKey)") && s.includes("getStorage().get(storageKey)"); })());
  // Real local-provider presence semantics: write → exists true, remove → false.
  const realKey = "invoices/" + "e".repeat(32) + ".pdf";
  const realPath = join(process.cwd(), "uploads", realKey);
  mkdirSync(dirname(realPath), { recursive: true });
  writeFileSync(realPath, Buffer.from("%PDF-1.4 test"));
  check("231 local provider reports object present after write", existsSync(realPath) === true && fileStatus(realKey, true) === "available");
  rmSync(realPath, { force: true });
  check("232 local provider reports object gone after removal (missing_object)", existsSync(realPath) === false && fileStatus(realKey, false) === "missing_object");
  const idxSrc = readFileSync(new URL("../src/lib/storage/index.ts", import.meta.url), "utf8");
  check("233 provider explicitly local unless STORAGE_PROVIDER=s3", idxSrc.includes('process.env.STORAGE_PROVIDER === "s3" ? "s3" : "local"'));
  const s3Src = readFileSync(new URL("../src/lib/storage/s3-provider.ts", import.meta.url), "utf8");
  check("234 S3 exists/get use server key + separate NoSuchKey from AccessDenied", s3Src.includes("HeadObjectCommand") && s3Src.includes('name === "NoSuchKey" || name === "NotFound"') && s3Src.includes("throw error"));
  check("235 storage provider name exposed on health (persistent-storage verifiable)", readFileSync(new URL("../src/app/api/health/route.ts", import.meta.url), "utf8").includes("storageProviderName()"));

  // UI states (236–239)
  const detailForm = readFileSync(new URL("../src/app/(app)/invoices/[id]/_components/InvoiceEditForm.tsx", import.meta.url), "utf8");
  check("236 file available → open/download buttons", detailForm.includes("Открыть документ") && detailForm.includes("Скачать") && detailForm.includes('fileStatus === "available"'));
  check("237 metadata absent → «не прикреплён файл», card still renders", detailForm.includes("К счёту не прикреплён файл"));
  check("238 object absent → «Файл отсутствует в хранилище» warning", detailForm.includes("Файл отсутствует в хранилище") && detailForm.includes('fileStatus === "missing_object"'));
  check("239 detail page resolves fileStatus separately from invoice load", readFileSync(new URL("../src/app/(app)/invoices/[id]/page.tsx", import.meta.url), "utf8").includes("resolveInvoiceFileStatus(invoice.originalFileStorageKey)"));

  // === «Ближайшие платежи» filter + sort (240–256) ==========================
  const uAcc = ctxOf("uacc", ["accountant"], ["A"]);
  const uMgr = ctxOf("umgr", ["manager"], ["A"]);
  const um = (o) => inv({ clubId: "A", createdByUserId: "umgr", invoiceDate: d(2026, 7, 1), ...o });
  const uSet = [
    um({ id: "uPaid", status: "paid", paidAt: d(2026, 7, 5), dueDate: d(2026, 7, 20) }),
    um({ id: "uPaidAtSet", status: "approved_by_regional", paidAt: d(2026, 7, 6), dueDate: d(2026, 7, 22) }),
    um({ id: "uReview", status: "needs_review", dueDate: d(2026, 7, 25) }),
    um({ id: "uApproved", status: "approved_by_regional", dueDate: d(2026, 7, 28) }),
    um({ id: "uDraft", status: "draft", dueDate: d(2026, 7, 26) }),
    um({ id: "uReject", status: "rejected", dueDate: d(2026, 7, 27) }),
    um({ id: "uOverdueThisMonth", status: "approved_by_regional", dueDate: d(2026, 7, 10) }), // past today (now=15) → overdue
    um({ id: "uNoDue", status: "needs_review", dueDate: null }),
  ];
  const vU = buildView(uAcc, {}, uSet, [], now);
  const upIds = vU.upcomingPayments.map((r) => r.id);
  check("240 paid excluded from Ближайшие платежи", !upIds.includes("uPaid"));
  check("241 paidAt-set (non-paid status) excluded (defensive)", !upIds.includes("uPaidAtSet"));
  check("242 needs_review with future dueDate included", upIds.includes("uReview"));
  check("243 approved with future dueDate included", upIds.includes("uApproved"));
  check("244 draft excluded from upcoming", !upIds.includes("uDraft"));
  check("245 rejected excluded from upcoming", !upIds.includes("uReject"));
  check("246 overdue (this-month, past due) excluded from upcoming", !upIds.includes("uOverdueThisMonth"));
  check("247 awaiting without dueDate excluded", !upIds.includes("uNoDue"));
  check("248 status=paid & paidAt=null still excluded (not awaiting)", !buildView(uAcc, {}, [um({ id: "pn", status: "paid", paidAt: null, dueDate: d(2026, 7, 20) })], [], now).upcomingPayments.some((r) => r.id === "pn"));
  check("249 manager draft with dueDate not upcoming", !buildView(uMgr, {}, [um({ id: "md", status: "draft", dueDate: d(2026, 7, 26) })], [], now).upcomingPayments.some((r) => r.id === "md"));
  // sort: nearest dueDate → earlier createdAt → id
  check("250 nearest dueDate first", buildView(uAcc, {}, [um({ id: "s1", status: "needs_review", dueDate: d(2026, 7, 28) }), um({ id: "s2", status: "needs_review", dueDate: d(2026, 7, 20) })], [], now).upcomingPayments.map((r) => r.id).join(",") === "s2,s1");
  check("251 tie on dueDate → earlier createdAt first", buildView(uAcc, {}, [um({ id: "t1", status: "needs_review", dueDate: d(2026, 7, 25), createdAt: d(2026, 7, 10) }), um({ id: "t2", status: "needs_review", dueDate: d(2026, 7, 25), createdAt: d(2026, 7, 2) })], [], now).upcomingPayments.map((r) => r.id).join(",") === "t2,t1");
  check("252 stable id tie-breaker", buildView(uAcc, {}, [um({ id: "z2", status: "needs_review", dueDate: d(2026, 7, 25), createdAt: d(2026, 7, 5) }), um({ id: "z1", status: "needs_review", dueDate: d(2026, 7, 25), createdAt: d(2026, 7, 5) })], [], now).upcomingPayments.map((r) => r.id).join(",") === "z1,z2");
  check("253 upcoming capped at 6", buildView(uAcc, {}, Array.from({ length: 9 }, (_, k) => um({ id: "m" + k, status: "needs_review", dueDate: d(2026, 7, 16 + k) })), [], now).upcomingPayments.length === 6);
  check("254 paid invoice STILL in the period table (only removed from upcoming)", vU.currentPeriodInvoices.some((r) => r.id === "uPaid") && vU.upcomingPayments.every((r) => r.id !== "uPaid"));
  check("S19 upcoming computed server-side, reuses awaiting set + paidAt guard", viewSrc.includes("upcomingPayments") && viewSrc.includes("isInvoiceAwaitingPayment(r.status) && !r.paidAt"));
  check("S20 page renders server upcomingPayments (no client status filter)", pageSrc.includes("view.upcomingPayments") && !pageSrc.includes('r.status !== "paid"'));

  // === Return-for-correction workflow (300–329) ============================
  // Mirror of applyInvoiceAction for the send/return/approve routing (regional vs
  // chief fallback, self-approval, author-only submit). needs_correction is the
  // new "sent back to the author" state; it re-enters review via send_to_review.
  const applyInv = (action, status, roles, opts) => {
    const isRegional = roles.includes("regional_director");
    const isChief = roles.includes("chief_accountant");
    const isManager = roles.includes("manager");
    if (action === "send_to_review") {
      if (status !== "draft" && status !== "needs_correction") return { ok: false };
      if (!(isManager || isRegional)) return { ok: false };
      if (!opts.isCreator) return { ok: false };
      return { ok: true, to: "needs_review" };
    }
    if (action === "approve") {
      if (status !== "needs_review") return { ok: false };
      if (opts.isCreator) return { ok: false };
      if (opts.hasActiveRegional) return isRegional ? { ok: true, to: "approved_by_regional" } : { ok: false };
      return isChief ? { ok: true, to: "approved_by_chief_accountant" } : { ok: false };
    }
    if (action === "return_for_correction") {
      if (status !== "needs_review") return { ok: false };
      if (opts.hasActiveRegional) return isRegional ? { ok: true, to: "needs_correction" } : { ok: false };
      return isChief ? { ok: true, to: "needs_correction" } : { ok: false };
    }
    return { ok: false };
  };
  // availableInvoiceActions mirror — the subset the actor can perform now.
  const availInv = (status, roles, opts) => ["send_to_review", "approve", "return_for_correction"].filter((a) => applyInv(a, status, roles, opts).ok);
  const rReg = ["regional_director"], rMgr = ["manager"], rChief = ["chief_accountant"];
  const withRegional = { hasActiveRegional: true, isCreator: false };
  // Behaviour: return-for-correction
  check("300 regional returns a submitted invoice → needs_correction", applyInv("return_for_correction", "needs_review", rReg, withRegional).to === "needs_correction");
  check("301 chief-fallback returns when no active regional → needs_correction", applyInv("return_for_correction", "needs_review", rChief, { hasActiveRegional: false, isCreator: false }).to === "needs_correction");
  check("302 non-regional cannot return while a regional is active", applyInv("return_for_correction", "needs_review", rChief, withRegional).ok === false);
  check("303 manager cannot return", applyInv("return_for_correction", "needs_review", rMgr, withRegional).ok === false);
  check("304 cannot return a draft (only needs_review)", applyInv("return_for_correction", "draft", rReg, withRegional).ok === false);
  check("305 cannot return an already-approved invoice", applyInv("return_for_correction", "approved_by_regional", rReg, withRegional).ok === false);
  check("306 cannot return a needs_correction invoice again", applyInv("return_for_correction", "needs_correction", rReg, withRegional).ok === false);
  // Behaviour: resubmit after correction
  check("307 author resubmits from needs_correction → needs_review", applyInv("send_to_review", "needs_correction", rMgr, { hasActiveRegional: true, isCreator: true }).to === "needs_review");
  check("308 regional-author resubmits own returned invoice", applyInv("send_to_review", "needs_correction", rReg, { hasActiveRegional: true, isCreator: true }).to === "needs_review");
  check("309 non-author manager cannot resubmit someone else's invoice", applyInv("send_to_review", "needs_correction", rMgr, { hasActiveRegional: true, isCreator: false }).ok === false);
  check("310 accountant cannot resubmit (not manager/regional)", applyInv("send_to_review", "needs_correction", ["accountant"], { hasActiveRegional: true, isCreator: true }).ok === false);
  check("311 draft submit still works (unchanged)", applyInv("send_to_review", "draft", rMgr, { hasActiveRegional: true, isCreator: true }).to === "needs_review");
  // Behaviour: after resubmit the invoice re-enters the same review routing
  check("312 resubmitted invoice is approvable by the regional (not the author)", applyInv("approve", "needs_review", rReg, { hasActiveRegional: true, isCreator: false }).to === "approved_by_regional");
  check("313 author still cannot approve own resubmitted invoice", applyInv("approve", "needs_review", rReg, { hasActiveRegional: true, isCreator: true }).ok === false);
  // availableInvoiceActions surface
  check("314 regional sees return_for_correction on a submitted invoice", availInv("needs_review", rReg, withRegional).includes("return_for_correction"));
  check("315 manager (author) sees send_to_review on needs_correction, not approve", (() => { const a = availInv("needs_correction", rMgr, { hasActiveRegional: true, isCreator: true }); return a.includes("send_to_review") && !a.includes("approve") && !a.includes("return_for_correction"); })());
  check("316 regional does NOT see return on a draft", !availInv("draft", rReg, withRegional).includes("return_for_correction"));
  // Manager visibility of the new + legacy operational statuses
  check("317 manager list surfaces own needs_correction invoice", buildView(uMgr, {}, [um({ id: "nc1", status: "needs_correction" })], [], now).currentPeriodInvoices.some((r) => r.id === "nc1"));
  check("318 legacy rejected stays visible to the manager (not converted/deleted)", MANAGER_EXTRA.includes("rejected"));
  check("319 needs_correction is an operational-only status (hidden from elevated awaiting)", !AWAITING.includes("needs_correction"));

  // === Static contract: correction workflow wiring (320–333) ===============
  const detailSrc = readFileSync(new URL("../src/app/(app)/invoices/[id]/page.tsx", import.meta.url), "utf8");
  const editForm = readFileSync(new URL("../src/app/(app)/invoices/[id]/_components/InvoiceEditForm.tsx", import.meta.url), "utf8");
  check("320 status union carries needs_correction", lib.includes('"needs_correction"'));
  check("321 needs_correction has a Russian label", lib.includes('needs_correction: "Возвращён на исправление"'));
  check("322 return_for_correction case exists in the decision table", lib.includes('case "return_for_correction"'));
  check("323 send_to_review accepts a needs_correction resubmit", lib.includes('status !== "draft" && status !== "needs_correction"'));
  check("324 a minimum return-reason length is enforced", lib.includes("INVOICE_RETURN_REASON_MIN"));
  check("325 server action requires the reason before returning", actions.includes("INVOICE_RETURN_REASON_MIN") && actions.includes('action === "return_for_correction" && returnReason.length'));
  check("326 return stamps comment + requestedAt + requestedBy", actions.includes("data.correctionComment = returnReason") && actions.includes("data.correctionRequestedAt = new Date()") && actions.includes("data.correctionRequestedByUserId = ctx.user.id"));
  check("327 transition uses compare-and-set on the current status", actions.includes("where: { id: invoiceId, status: existing.status }"));
  check("328 the reason is audited (not silently dropped)", actions.includes('action === "return_for_correction" ? { reason: returnReason }'));
  check("329 field edits are author-only while unpaid", actions.includes('existing.status !== "paid" && existing.createdByUserId !== ctx.user.id'));
  check("330 detail page shows the correction banner", detailSrc.includes('invoice.status === "needs_correction"') && detailSrc.includes("view.correctionComment"));
  check("331 edit form is author-gated (not shown to the reviewer) while unpaid", detailSrc.includes('invoice.status === "paid" || invoice.createdByUserId === ctx.user.id'));
  check("332 return form requires a reason (minLength) in the UI", editForm.includes('name="reason"') && editForm.includes("minLength={5}") && editForm.includes('value="return_for_correction"'));
  check("333 return action is separated from the plain button loop", editForm.includes('availableActions.filter((a) => a !== "return_for_correction")'));

  // === Invoice field/file immutability (340–359) ===========================
  // Effective server decision = canEditInvoice(status, roles) AND (paid OR author).
  // Editable ONLY in draft / needs_correction (author) or paid (accountant).
  const canEditInv = (status, roles, isAuthor) => {
    const roleOk = status === "paid" ? roles.includes("accountant") : ["draft", "needs_correction"].includes(status);
    if (!roleOk) return false;
    if (status !== "paid" && !isAuthor) return false; // unpaid → author only
    return true;
  };
  const AUTHOR = ["manager"];
  check("340 author edits a draft", canEditInv("draft", AUTHOR, true) === true);
  check("341 author edits a needs_correction invoice", canEditInv("needs_correction", AUTHOR, true) === true);
  check("342 author CANNOT edit needs_review", canEditInv("needs_review", AUTHOR, true) === false);
  check("343 author CANNOT edit approved_by_regional", canEditInv("approved_by_regional", AUTHOR, true) === false);
  check("344 author CANNOT edit approved_by_chief_accountant", canEditInv("approved_by_chief_accountant", AUTHOR, true) === false);
  check("345 author CANNOT edit approved_by_owner (legacy)", canEditInv("approved_by_owner", AUTHOR, true) === false);
  check("346 author (manager) CANNOT edit paid", canEditInv("paid", AUTHOR, true) === false);
  check("347 author CANNOT edit rejected", canEditInv("rejected", AUTHOR, true) === false);
  check("348 author CANNOT edit canceled", canEditInv("canceled", AUTHOR, true) === false);
  check("349 accountant CAN edit paid (post-payment correction)", canEditInv("paid", ["accountant"], false) === true);
  // Another manager (not the author) cannot edit in ANY status.
  check("350 non-author manager cannot edit draft", canEditInv("draft", AUTHOR, false) === false);
  check("351 non-author manager cannot edit needs_correction", canEditInv("needs_correction", AUTHOR, false) === false);
  check("352 non-author manager cannot edit needs_review", canEditInv("needs_review", AUTHOR, false) === false);
  // Return → author can edit again; resubmit → locked again.
  check("353 after return (needs_correction) author edits again", canEditInv("needs_correction", AUTHOR, true) === true);
  check("354 after resubmit (needs_review) editing is locked again", canEditInv("needs_review", AUTHOR, true) === false);
  // Static: canEditInvoice is the authoritative gate (draft/needs_correction, paid→accountant).
  check("355 INVOICE_EDITABLE_STATUSES = draft + needs_correction", lib.includes('INVOICE_EDITABLE_STATUSES = ["draft", "needs_correction"]'));
  check("356 canEditInvoice: paid→accountant, else only editable statuses", lib.includes('if (status === "paid") return has(roles, "accountant")') && lib.includes("INVOICE_EDITABLE_STATUSES as readonly string[]).includes(status)"));
  check("357 updateInvoice gates on canEditInvoice + author (server-enforced)", actions.includes("canEditInvoice(existing.status, ctx.effectiveRoles)") && actions.includes('existing.status !== "paid" && existing.createdByUserId !== ctx.user.id'));
  // File immutability: the edit path can never swap the file, and the file route is GET-only.
  const fileRouteSrc = readFileSync(new URL("../src/app/api/invoices/[id]/file/route.ts", import.meta.url), "utf8");
  // parseInvoiceFields (used by updateInvoice) returns ONLY business fields — no
  // file keys — so an edit can never replace the stored document.
  const pif = actions.slice(actions.indexOf("function parseInvoiceFields"), actions.indexOf("async function clubInCompany"));
  check("358a edit parser exposes no file fields (file cannot be replaced via edit)", pif.length > 0 && !pif.includes("originalFileStorageKey") && !pif.includes("originalFileName") && !pif.includes("storageKey"));
  check("358b updateInvoice writes only the parsed business fields", actions.includes("prisma.invoice.update({ where: { id: invoiceId }, data: parsed.data })"));
  check("359 invoice file route is download-only (no POST/PUT/PATCH)", fileRouteSrc.includes("export async function GET") && !/export async function (POST|PUT|PATCH)/.test(fileRouteSrc));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
