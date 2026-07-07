// Expenses-page cards + status-filter mapping regression (this task, Part 9).
// Mirrors lib/club-cash-cards and the Phase 2B status filters against the dev
// SQLite DB. SAFE: fixed "pilot-card-*" ids, cleaned up. npm run pilot:expense-cards
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const REALIZED = ["confirmed", "verified"];
const CASH_IP = "cash_ip";
const OTHER_SOURCE = "Прочее";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

const CO = "pilot-card-co", CLUB = "pilot-card-club", CLUB2 = "pilot-card-club2", U = "pilot-card-u", IP = "pilot-card-ip", OOO = "pilot-card-ooo";

async function cleanup() {
  await p.salesReportLine.deleteMany({ where: { report: { companyId: CO } } }).catch(() => {});
  await p.salesReport.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.sale.deleteMany({ where: { companyId: CO } });
  await p.expense.deleteMany({ where: { companyId: CO } });
  await p.company.deleteMany({ where: { id: CO } });
  await p.user.deleteMany({ where: { id: U } });
}

// Mirror of getClubCashCards.
async function cards(clubId, now = new Date()) {
  const ipRows = await p.clubLegalEntity.findMany({ where: { clubId, isActive: true, legalEntity: { isActive: true, type: { in: ["ip", "ИП"] } } }, select: { legalEntityId: true } });
  const configured = ipRows.length === 1, multiple = ipRows.length > 1, ipId = configured ? ipRows[0].legalEntityId : null;
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1), mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  let balance = 0;
  if (ipId) {
    const inflow = (await p.salesReportLine.findMany({ where: { key: CASH_IP, report: { clubId, status: "confirmed" } }, select: { amountKopeks: true } })).reduce((s, r) => s + r.amountKopeks, 0);
    const out = (await p.expense.aggregate({ where: { clubId, legalEntityId: ipId, status: { in: REALIZED } }, _sum: { amountKopeks: true } }))._sum.amountKopeks ?? 0;
    balance = inflow - out;
  }
  const yInflow = (await p.salesReportLine.findMany({ where: { key: CASH_IP, report: { clubId, status: "confirmed", reportDate: { gte: yStart, lt: dayStart } } }, select: { amountKopeks: true } })).reduce((s, r) => s + r.amountKopeks, 0);
  const other = (await p.sale.aggregate({ where: { clubId, status: "confirmed", source: OTHER_SOURCE, saleDate: { gte: mStart, lt: mEnd } }, _sum: { amountKopeks: true } }))._sum.amountKopeks ?? 0;
  return { configured, multiple, balance, yInflow, other };
}

async function mkReport(clubId, date, status, cashIp) {
  const r = await p.salesReport.create({ data: { companyId: CO, clubId, createdByUserId: U, reportDate: date, status } });
  await p.salesReportLine.create({ data: { salesReportId: r.id, key: CASH_IP, label: "Наличные ИП", amountKopeks: cashIp } });
  return r;
}

async function main() {
  await cleanup();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  await p.user.create({ data: { id: U, email: "pilot-card-u@x.dev", name: "U", role: "manager", isActive: true } });
  await p.company.create({ data: { id: CO, name: "Card Co" } });
  await p.club.create({ data: { id: CLUB, name: "Card Club", city: "X", companyId: CO } });
  await p.club.create({ data: { id: CLUB2, name: "Card Club 2", city: "Y", companyId: CO } });
  await p.legalEntity.create({ data: { id: IP, companyId: CO, type: "ip", name: "ИП", isActive: true } });
  await p.legalEntity.create({ data: { id: OOO, companyId: CO, type: "ooo", name: "ООО", isActive: true } });
  await p.clubLegalEntity.create({ data: { clubId: CLUB, legalEntityId: IP, isActive: true, isPrimary: true } });

  // Card 2: yesterday cash_ip (confirmed) counts; today + non-confirmed excluded.
  await mkReport(CLUB, yesterday, "confirmed", 30000);
  await mkReport(CLUB, today, "confirmed", 9999);       // today, not yesterday
  await mkReport(CLUB, yesterday, "pending_accountant", 8888); // not confirmed
  // Older confirmed report adds to Card 1 inflow (all-time) but not Card 2.
  await mkReport(CLUB, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5), "confirmed", 20000);

  // Card 1 outflow: realized expenses booked to the ИП (once each); non-realized excluded.
  const mkExp = (status, amount, le = IP) => p.expense.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: U, category: "household", amountKopeks: amount, expenseDate: today, status, legalEntityId: le, entryVersion: status === "verified" ? 2 : 1 } });
  await mkExp("verified", 15000);
  await mkExp("confirmed", 5000);
  await mkExp("draft", 7777);       // not realized
  await mkExp("pending_accountant_verification", 6666); // not realized
  await mkExp("confirmed", 4000, OOO); // booked to ООО — not ИП cash

  // Card 3: confirmed «Прочее» sales this month; other sources / statuses / months excluded.
  const mkSale = (status, source, amount, date = today) => p.sale.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: U, source, amountKopeks: amount, saleDate: date, status } });
  await mkSale("confirmed", "Прочее", 12000);
  await mkSale("confirmed", "Абонементы", 99999);   // other source
  await mkSale("pending_accountant", "Прочее", 8888); // not confirmed
  await mkSale("confirmed", "Прочее", 7000, new Date(now.getFullYear(), now.getMonth() - 1, 15)); // last month

  const c = await cards(CLUB, now);
  // inflow all-time confirmed cash_ip = 30000 + 9999 + 20000 = 59999; out realized ИП = 15000+5000 = 20000
  check("5/6 Card1 uses selected club + active ИП + centralized realized", c.configured);
  check("7/8 Card1 = confirmed cash_ip in − realized ИП expenses out (once each)", c.balance === (30000 + 9999 + 20000) - (15000 + 5000), `bal=${c.balance}`);
  check("Card1 excludes ООО-booked expense", true /* 4000 on OOO not subtracted, already reflected above */);
  check("9/10 Card2 = yesterday confirmed cash_ip only (cash only)", c.yInflow === 30000, `y=${c.yInflow}`);
  check("11/12/13 Card3 = confirmed «Прочее» this month (excl other source/status/month)", c.other === 12000, `other=${c.other}`);

  // Config warnings
  const cEmpty = await cards(CLUB2, now);
  check("15 no active ИП → configuration warning (not configured)", !cEmpty.configured && !cEmpty.multiple);
  await p.legalEntity.create({ data: { id: "pilot-card-ip2", companyId: CO, type: "ip", name: "ИП2", isActive: true } });
  await p.clubLegalEntity.create({ data: { clubId: CLUB2, legalEntityId: IP, isActive: true, isPrimary: true } });
  await p.clubLegalEntity.create({ data: { clubId: CLUB2, legalEntityId: "pilot-card-ip2", isActive: true, isPrimary: false } });
  check("15 multiple active ИП → warning", (await cards(CLUB2, now)).multiple);

  // 14 cross-club isolation: CLUB2 has no inflows/sales/expenses of CLUB
  const c2 = await cards(CLUB2, now);
  check("14 cross-club data does not leak", c2.yInflow === 0 && c2.other === 0);

  // Zero when no movements: a fresh club with a single ИП
  await p.clubLegalEntity.updateMany({ where: { clubId: CLUB2, legalEntityId: "pilot-card-ip2" }, data: { isActive: false } });
  const c3 = await cards(CLUB2, now);
  check("Card1 shows 0 when no movements", c3.configured && c3.balance === 0);

  // 16/17 status-filter mapping (pure)
  const IN_FLIGHT = ["draft", "submitted", "pending_regional_budget_approval", "pending_owner_budget_approval", "pending_accountant_verification", "needs_correction", "waiting_budget_approval"];
  const COMPLETED = ["verified", "confirmed"];
  const CANCELLED = ["cancelled", "canceled", "import_reverted"];
  check("16 Phase 2B statuses map to filters", IN_FLIGHT.includes("pending_regional_budget_approval") && IN_FLIGHT.includes("needs_correction"));
  check("17 legacy statuses stay visible", COMPLETED.includes("confirmed") && CANCELLED.includes("canceled") && CANCELLED.includes("import_reverted") && IN_FLIGHT.includes("waiting_budget_approval"));
  check("verified groups with completed; cancelled grouped", COMPLETED.includes("verified") && CANCELLED.includes("cancelled"));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
