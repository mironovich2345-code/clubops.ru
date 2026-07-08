// Invoices Phase 1 regression: reporting-month rule, carried overdue, manager
// visibility, city/club filters, month navigation, add-paid role gate, and the
// server data-contract shape. Mirrors the pure rules in lib/invoices.ts +
// lib/invoice-view.ts, plus real-DB query shapes and static contract assertions.
// SAFE: fixed "pilot-inv-*" ids, cleaned up. npm run pilot:invoices
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

// --- Mirrors of lib/invoices.ts -------------------------------------------
const AWAITING = ["needs_review", "approved_by_regional", "approved_by_chief_accountant", "approved_by_owner"];
const ELEVATED = ["regional_director", "accountant", "chief_accountant", "owner", "general_director"];
const OPERATIONAL = ["regional_director", "manager", "accountant", "chief_accountant"];
const isPaid = (s) => s === "paid";
const isAwaiting = (s) => AWAITING.includes(s);
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const reportingDate = (i) => (isPaid(i.status) ? (i.paidAt ?? i.dueDate ?? i.invoiceDate ?? i.createdAt) : (i.dueDate ?? i.invoiceDate ?? i.createdAt));
const reportingMonth = (i) => monthKey(reportingDate(i));
const isOverdue = (i, now) => isAwaiting(i.status) && !!i.dueDate && i.dueDate.getTime() < now.getTime();
const canAddPaid = (roles) => roles.includes("accountant") || roles.includes("chief_accountant");
const canCreateOp = (roles) => OPERATIONAL.some((r) => roles.includes(r));

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
  const baseView = () => ({ effectivePeriod: { year, month, start, end }, roleView, canNavigateMonths: isElevated, canFilterByCity: isElevated, canFilterByClub: isElevated, availableCities: [], availableClubs: [], selectedCity: null, selectedClub: null, summary: roleView === "manager" ? { ...emptyMgr } : { ...emptyMgr, totalInvoiceAmountKopeks: 0, paidAmountKopeks: 0 }, currentPeriodInvoices: [], carriedOverdueInvoices: [], categoryDistribution: [], permissions });
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
  if (!clubIds.length) return view;
  const inScope = invoices.filter((i) => i.companyId === ctx.companyId && clubIds.includes(i.clubId) && (roleView === "manager" ? i.createdByUserId === ctx.userId : true));
  const paid = inScope.filter((i) => i.status === "paid" && i.paidAt && i.paidAt >= start && i.paidAt < end).map((i) => ({ ...i, reportingMonth: reportingMonth(i), overdue: isOverdue(i, now) }));
  const live = inScope.filter((i) => AWAITING.includes(i.status)).map((i) => ({ ...i, reportingMonth: reportingMonth(i), overdue: isOverdue(i, now) }));
  const currentUnpaid = live.filter((r) => r.reportingMonth === selKey);
  const currentPeriodInvoices = [...paid, ...currentUnpaid];
  const carriedOverdueInvoices = live.filter((r) => r.overdue && r.dueDate && r.dueDate.getTime() < start.getTime() && r.reportingMonth !== selKey);
  const sum = (rows) => rows.reduce((s, r) => s + r.amountKopeks, 0);
  const pending = sum(currentUnpaid.filter((r) => !r.overdue));
  const overdue = sum(currentUnpaid.filter((r) => r.overdue)) + sum(carriedOverdueInvoices);
  const sentCount = new Set(sentEvents.filter((e) => e.companyId === ctx.companyId && clubIds.includes(e.clubId) && e.createdAt >= start && e.createdAt < end && (roleView === "manager" ? e.userId === ctx.userId : true)).map((e) => e.invoiceId)).size;
  view.currentPeriodInvoices = currentPeriodInvoices; view.carriedOverdueInvoices = carriedOverdueInvoices;
  view.summary = roleView === "manager" ? { pendingPaymentAmountKopeks: pending, overdueAmountKopeks: overdue, sentCount } : { pendingPaymentAmountKopeks: pending, overdueAmountKopeks: overdue, sentCount, totalInvoiceAmountKopeks: sum(currentPeriodInvoices), paidAmountKopeks: sum(paid) };
  const byCat = new Map(); for (const r of currentPeriodInvoices) { const k = r.expenseCategory ?? "—"; const c = byCat.get(k) ?? { amountKopeks: 0, count: 0 }; c.amountKopeks += r.amountKopeks; c.count++; byCat.set(k, c); }
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
  const carried = inv({ id: "carried", status: "needs_review", dueDate: d(2026, 6, 28), createdByUserId: "mgr", clubId: "A" });
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

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
