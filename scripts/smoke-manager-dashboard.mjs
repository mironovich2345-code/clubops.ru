// Smoke test: the manager dashboard is sales-only.
//
// Seeds an isolated 2-club company with sales + expenses + invoice debt + budget
// + plan + audit, then renders /dashboard for an owner and a manager and asserts
// the owner sees every financial block while the manager sees only the sales
// blocks (Выполнение плана, Продажи на проверке) and none of the financial ones.
//
// Run: npm run smoke:manager-dashboard   (requires `npm run dev`)
import { PrismaClient } from "@prisma/client";
import { createHmac, randomBytes } from "node:crypto";

const p = new PrismaClient();
const SECRET = "local-dev-secret-not-for-production";
const hashToken = (t) => createHmac("sha256", SECRET).update(t).digest("hex");
const BASE = "http://localhost:3000";
const CO = "dash-co";
const A = "dash-club-a";
const B = "dash-club-b";
const now = new Date();
const MONTH = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const mid = new Date(now.getFullYear(), now.getMonth(), 2, 12, 0, 0);

let pass = 0, fail = 0;
const check = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  :: " + e : ""}`); c ? pass++ : fail++; };
async function sess(userId) { const t = randomBytes(32).toString("hex"); await p.session.create({ data: { userId, tokenHash: hashToken(t), expiresAt: new Date(Date.now() + 864e5) } }); return t; }
const dash = async (token) => (await fetch(`${BASE}/dashboard`, { headers: { cookie: `club_ops_session=${token}` } })).text();

let ownerId;
async function cleanup() {
  await p.auditLog.deleteMany({ where: { companyId: CO } });
  await p.company.deleteMany({ where: { id: CO } });
  await p.session.deleteMany({ where: { user: { email: { startsWith: "dashe2e-" } } } });
  await p.user.deleteMany({ where: { email: { startsWith: "dashe2e-" } } });
}

// Block-title discriminators that do NOT appear in the sidebar nav.
const FIN_BLOCKS = ["Прибыль", "Требует внимания", "Долги", "Последние расходы", "Исполнение бюджета", "Рейтинг клубов", "Последние действия"];
const SALES_BLOCKS = ["Выполнение плана", "Продажи на проверке"];

async function main() {
  await cleanup();
  await p.company.create({ data: { id: CO, name: "Dash Co" } });
  await p.club.createMany({ data: [{ id: A, companyId: CO, name: "Клуб A", city: "Москва" }, { id: B, companyId: CO, name: "Клуб B", city: "Питер" }] });
  const owner = await p.user.create({ data: { email: "dashe2e-owner@t.local", name: "Owner", role: "manager", isActive: true } }); ownerId = owner.id;
  const mgr = await p.user.create({ data: { email: "dashe2e-mgr@t.local", name: "Manager", role: "manager", isActive: true } });
  await p.companyUserAccess.create({ data: { companyId: CO, userId: owner.id, role: "owner" } });
  await p.clubUserAccess.create({ data: { clubId: A, userId: mgr.id, role: "manager" } });
  const [tOwn, tMgr] = await Promise.all([sess(owner.id), sess(mgr.id)]);

  // Seed data so financial blocks WOULD render for the owner.
  await p.sale.create({ data: { companyId: CO, clubId: A, createdByUserId: owner.id, source: "Абонементы", amountKopeks: 500000, saleDate: mid, status: "confirmed" } });
  await p.sale.create({ data: { companyId: CO, clubId: A, createdByUserId: owner.id, source: "Товары", amountKopeks: 70000, saleDate: mid, status: "pending_accountant" } });
  await p.expense.create({ data: { companyId: CO, clubId: A, createdByUserId: owner.id, type: "manual", category: "advertising", amountKopeks: 142000, currency: "RUB", expenseDate: mid, status: "confirmed" } });
  await p.invoice.create({ data: { companyId: CO, clubId: A, createdByUserId: owner.id, expenseCategory: "other", amountKopeks: 99000, currency: "RUB", invoiceDate: mid, status: "approved_by_owner" } }); // debt
  await p.budget.create({ data: { companyId: CO, clubId: A, category: "advertising", month: MONTH, limitAmountKopeks: 100000, createdByUserId: owner.id } });
  await p.salesPlan.create({ data: { companyId: CO, clubId: A, month: MONTH, targetAmountKopeks: 1000000, createdByUserId: owner.id } });
  await p.auditLog.create({ data: { companyId: CO, clubId: A, userId: owner.id, action: "sale.created", entityType: "Sale", createdAt: mid } });

  const ownerHtml = await dash(tOwn);
  const mgrHtml = await dash(tMgr);

  // Owner sees financial + sales blocks.
  check("owner sees all financial blocks", FIN_BLOCKS.every((b) => ownerHtml.includes(b)), FIN_BLOCKS.filter((b) => !ownerHtml.includes(b)).join(",") || "ok");
  check("owner sees sales blocks", SALES_BLOCKS.every((b) => ownerHtml.includes(b)));

  // Manager sees sales blocks only.
  check("manager sees sales blocks (Выполнение плана, Продажи на проверке)", SALES_BLOCKS.every((b) => mgrHtml.includes(b)), SALES_BLOCKS.filter((b) => !mgrHtml.includes(b)).join(",") || "ok");
  for (const b of FIN_BLOCKS) {
    check(`manager does NOT see "${b}"`, !mgrHtml.includes(b));
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await cleanup();
  console.log("cleanup done");
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); try { await cleanup(); } catch {} await p.$disconnect(); process.exit(1); });
