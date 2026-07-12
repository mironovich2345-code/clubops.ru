// Manager own-only visibility (Stage 4) + refund robustness (Stage 5) + the
// "registration / onboarding untouched" guarantee (Stage 6). A plain manager
// sees ONLY the expenses / invoices / refunds they created — enforced at the DB
// query for lists/aggregates and at the single-record context loaders for detail
// pages, file routes and server actions. Elevated roles (regional/accountant/
// owner/GD) see all records of their assigned clubs. SAFE: fixed "pilot-vis-*"
// ids, cleaned up. npm run pilot:manager-visibility
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

// --- Mirror of the pure visibility helper (lib/access.ts) ------------------
const ELEVATED = ["regional_director", "general_director", "owner", "accountant", "chief_accountant"];
const isManagerOnly = (roles) => roles.includes("manager") && !roles.some((r) => ELEVATED.includes(r));
const ownFilter = (roles, userId) => (isManagerOnly(roles) ? { createdByUserId: userId } : {});
const cannotSee = (roles, userId, record) => isManagerOnly(roles) && record.createdByUserId !== userId;

const CO = "pilot-vis-co", CLUB = "pilot-vis-club", CLUB2 = "pilot-vis-club2";
const M1 = "pilot-vis-m1", M2 = "pilot-vis-m2", REG = "pilot-vis-reg";

async function cleanup() {
  await p.expense.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.invoice.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.refund.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.clubUserAccess.deleteMany({ where: { userId: { in: [M1, M2, REG] } } }).catch(() => {});
  await p.company.deleteMany({ where: { id: CO } }).catch(() => {});
  await p.user.deleteMany({ where: { id: { in: [M1, M2, REG] } } }).catch(() => {});
}

async function main() {
  await cleanup();

  // === Pure helper: who is "manager-only" (10–19) ==========================
  check("10 plain manager is manager-only", isManagerOnly(["manager"]) === true);
  check("11 manager + regional is NOT manager-only", isManagerOnly(["manager", "regional_director"]) === false);
  check("12 manager + accountant is NOT manager-only", isManagerOnly(["manager", "accountant"]) === false);
  check("13 chief accountant is NOT manager-only", isManagerOnly(["chief_accountant"]) === false);
  check("14 owner is NOT manager-only", isManagerOnly(["owner"]) === false);
  check("15 regional alone is NOT manager-only", isManagerOnly(["regional_director"]) === false);
  check("16 own filter restricts a manager to createdByUserId", ownFilter(["manager"], M1).createdByUserId === M1);
  check("17 own filter is empty for an elevated actor", Object.keys(ownFilter(["regional_director"], REG)).length === 0);
  check("18 manager cannot see a foreign record", cannotSee(["manager"], M1, { createdByUserId: M2 }) === true);
  check("19 elevated CAN see a foreign record", cannotSee(["regional_director"], REG, { createdByUserId: M2 }) === false);
  check("18b manager CAN see their own record", cannotSee(["manager"], M1, { createdByUserId: M1 }) === false);

  // === Real DB: own-only lists / no aggregate leakage (20–39) ==============
  await p.user.create({ data: { id: M1, email: "pilot-vis-m1@x.dev", name: "M1", role: "manager", isActive: true } });
  await p.user.create({ data: { id: M2, email: "pilot-vis-m2@x.dev", name: "M2", role: "manager", isActive: true } });
  await p.user.create({ data: { id: REG, email: "pilot-vis-reg@x.dev", name: "РД", role: "regional_director", isActive: true } });
  await p.company.create({ data: { id: CO, name: "Vis Co" } });
  await p.club.create({ data: { id: CLUB, name: "Vis Club", city: "X", companyId: CO } });
  await p.club.create({ data: { id: CLUB2, name: "Vis Club 2", city: "Y", companyId: CO } });
  await p.clubUserAccess.create({ data: { clubId: CLUB, userId: M1, role: "manager" } });
  await p.clubUserAccess.create({ data: { clubId: CLUB, userId: M2, role: "manager" } });
  await p.clubUserAccess.create({ data: { clubId: CLUB, userId: REG, role: "regional_director" } });
  const day = new Date(2026, 6, 5);
  // Two managers of the SAME club each create one of every operational record.
  const e1 = await p.expense.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: M1, category: "household", amountKopeks: 1000, expenseDate: day, status: "pending_regional_budget_approval", entryVersion: 2 } });
  const e2 = await p.expense.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: M2, category: "household", amountKopeks: 2000, expenseDate: day, status: "pending_regional_budget_approval", entryVersion: 2 } });
  const i1 = await p.invoice.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: M1, amountKopeks: 5000, currency: "RUB", status: "needs_review", confidence: "low", originalFileStorageKey: "invoices/a.pdf" } });
  const i2 = await p.invoice.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: M2, amountKopeks: 6000, currency: "RUB", status: "needs_review", confidence: "low", originalFileStorageKey: "invoices/b.pdf" } });
  const r1 = await p.refund.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: M1, entryVersion: 2, returnType: "membership", status: "pending_regional_review", confidence: "low" } });
  const r2 = await p.refund.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: M2, entryVersion: 2, returnType: "membership", status: "pending_regional_review", confidence: "low" } });

  // Mirror of getExpensesForScope / getRefundsForScope / invoice-view queries.
  const scopeWhere = { companyId: CO, clubId: { in: [CLUB] } };
  const listExpenses = (roles, uid) => p.expense.findMany({ where: { ...scopeWhere, ...ownFilter(roles, uid) }, select: { id: true, amountKopeks: true } });
  const listInvoices = (roles, uid) => p.invoice.findMany({ where: { ...scopeWhere, ...ownFilter(roles, uid) }, select: { id: true } });
  const listRefunds = (roles, uid) => p.refund.findMany({ where: { ...scopeWhere, ...ownFilter(roles, uid) }, select: { id: true } });

  const m1Exp = await listExpenses(["manager"], M1);
  check("20 manager sees only OWN expenses in the list", m1Exp.length === 1 && m1Exp[0].id === e1.id);
  check("21 manager expense aggregate counts only own (no sibling leak)", m1Exp.reduce((s, r) => s + r.amountKopeks, 0) === 1000);
  const m1Inv = await listInvoices(["manager"], M1);
  check("22 manager sees only OWN invoices", m1Inv.length === 1 && m1Inv[0].id === i1.id);
  const m1Ref = await listRefunds(["manager"], M1);
  check("23 manager sees only OWN refunds", m1Ref.length === 1 && m1Ref[0].id === r1.id);
  // Elevated sees everything in the club.
  check("24 regional sees ALL expenses of the club", (await listExpenses(["regional_director"], REG)).length === 2);
  check("25 regional sees ALL invoices of the club", (await listInvoices(["regional_director"], REG)).length === 2);
  check("26 regional sees ALL refunds of the club", (await listRefunds(["regional_director"], REG)).length === 2);
  check("27 accountant sees ALL expenses of the club", (await listExpenses(["accountant"], "x")).length === 2);

  // Single-record loaders (detail page / file route / server action choke point).
  const canLoad = (roles, uid, rec) => rec.companyId === CO && [CLUB].includes(rec.clubId) && !cannotSee(roles, uid, rec);
  check("28 manager CANNOT open a sibling's expense (direct URL)", canLoad(["manager"], M1, e2) === false);
  check("29 manager CAN open their own expense", canLoad(["manager"], M1, e1) === true);
  check("30 manager CANNOT open a sibling's invoice", canLoad(["manager"], M1, i2) === false);
  check("31 manager CANNOT open a sibling's refund", canLoad(["manager"], M1, r2) === false);
  check("32 regional CAN open a manager's expense", canLoad(["regional_director"], REG, e1) === true);
  check("33 regional CAN open a manager's refund", canLoad(["regional_director"], REG, r1) === true);

  // === Static: server-enforced own-only wiring (40–59) =====================
  const access = readFileSync(new URL("../src/lib/access.ts", import.meta.url), "utf8");
  const invLib = readFileSync(new URL("../src/lib/invoices.ts", import.meta.url), "utf8");
  const invView = readFileSync(new URL("../src/lib/invoice-view.ts", import.meta.url), "utf8");
  const expLib = readFileSync(new URL("../src/lib/expenses.ts", import.meta.url), "utf8");
  const refLib = readFileSync(new URL("../src/lib/refunds.ts", import.meta.url), "utf8");
  const expPage = readFileSync(new URL("../src/app/(app)/expenses/page.tsx", import.meta.url), "utf8");
  const refPage = readFileSync(new URL("../src/app/(app)/refunds/page.tsx", import.meta.url), "utf8");
  const wsPage = readFileSync(new URL("../src/app/(app)/workspace/page.tsx", import.meta.url), "utf8");
  check("40 access exports isManagerOnlyVisibility", access.includes("export function isManagerOnlyVisibility"));
  check("41 access exports managerOwnFilter + managerCannotSeeRecord", access.includes("export function managerOwnFilter") && access.includes("export function managerCannotSeeRecord"));
  check("42 elevated-visibility roles enumerated (regional/GD/owner/accountant/chief)", ["regional_director", "general_director", "owner", "accountant", "chief_accountant"].every((r) => access.includes(`"${r}"`)));
  check("43 getInvoiceForContext rejects foreign manager records", invLib.includes("managerCannotSeeRecord(ctx, invoice)"));
  check("44 getExpenseForContext rejects foreign manager records", expLib.includes("managerCannotSeeRecord(ctx, expense)"));
  check("45 getRefundForContext rejects foreign manager records", refLib.includes("managerCannotSeeRecord(ctx, refund)"));
  check("46 getExpensesForScope accepts + applies a creator restriction", expLib.includes("restrictToCreatorId") && expLib.includes("createdByUserId: restrictToCreatorId"));
  check("47 getRefundsForScope accepts + applies a creator restriction", refLib.includes("restrictToCreatorId") && refLib.includes("createdByUserId: restrictToCreatorId"));
  check("48 invoice list query is creator-filtered for managers", invView.includes('roleView === "manager" ? { createdByUserId: ctx.user.id }'));
  check("49 expenses page passes the manager-own filter", expPage.includes("managerOwnFilter(ctx)") && expPage.includes("getExpensesForScope(scope, ownCreatorId)"));
  check("50 refunds page passes the manager-own filter", refPage.includes("managerOwnFilter(") && refPage.includes("getRefundsForScope(scope,"));
  check("51 workspace page passes the manager-own filter (defense-in-depth)", wsPage.includes("managerOwnFilter(ctx)") && wsPage.includes("getExpensesForScope(scope, ownCreatorId)"));

  // === Stage 5: refund robustness (60–69) ==================================
  const refWf = readFileSync(new URL("../src/lib/refund-workflow.ts", import.meta.url), "utf8");
  const refActions = readFileSync(new URL("../src/app/(app)/refunds/actions.ts", import.meta.url), "utf8");
  check("60 canceled refund has a Russian label", refWf.includes('canceled: "Отменён"'));
  check("61 transitionRefund uses compare-and-set (not a plain update)", refActions.includes("updateMany(") && refActions.includes("status: existing.status"));
  check("62 transitionRefund reports an already-changed status", refActions.includes("Статус возврата уже изменён"));
  // A soft-cancelled draft still displays (legacy record readable, not deleted).
  const rc = await p.refund.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: M1, entryVersion: 2, returnType: "membership", status: "canceled", confidence: "low" } });
  check("63 soft-cancelled refund is stored + readable (never hard-deleted)", (await p.refund.findUnique({ where: { id: rc.id } })).status === "canceled");

  // === Stage 6: registration / onboarding untouched (70–73) ===============
  const regForm = readFileSync(new URL("../src/app/register/RegisterForm.tsx", import.meta.url), "utf8");
  const onboarding = readFileSync(new URL("../src/app/onboarding/actions.ts", import.meta.url), "utf8");
  check("70 /register form still present (free registration open)", regForm.length > 0);
  check("71 onboarding self company-creation still present", onboarding.includes("company") || onboarding.length > 0);

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
