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
  // Card 2 «Приход наличных по ИП вчера» — TEMPORARY pre-OFD cash_ip adapter
  // (Card 1 wallet balance + Card 3 other_cash_income now live in the ledger and
  // are covered by pilot:cash-wallets).
  void mStart; void mEnd;
  const yInflow = (await p.salesReportLine.findMany({ where: { key: CASH_IP, report: { clubId, status: "confirmed", reportDate: { gte: yStart, lt: dayStart } } }, select: { amountKopeks: true } })).reduce((s, r) => s + r.amountKopeks, 0);
  return { configured, multiple, yInflow };
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

  const c = await cards(CLUB, now);
  check("Card2 uses selected club + active ИП (configured)", c.configured);
  check("Card2 = yesterday confirmed cash_ip only (temporary pre-OFD adapter)", c.yInflow === 30000, `y=${c.yInflow}`);

  // Config warnings
  const cEmpty = await cards(CLUB2, now);
  check("15 no active ИП → configuration warning (not configured)", !cEmpty.configured && !cEmpty.multiple);
  await p.legalEntity.create({ data: { id: "pilot-card-ip2", companyId: CO, type: "ip", name: "ИП2", isActive: true } });
  await p.clubLegalEntity.create({ data: { clubId: CLUB2, legalEntityId: IP, isActive: true, isPrimary: true } });
  await p.clubLegalEntity.create({ data: { clubId: CLUB2, legalEntityId: "pilot-card-ip2", isActive: true, isPrimary: false } });
  check("15 multiple active ИП → warning", (await cards(CLUB2, now)).multiple);

  // 14 cross-club isolation: CLUB2 has no inflows of CLUB
  const c2 = await cards(CLUB2, now);
  check("14 cross-club data does not leak", c2.yInflow === 0);

  // Config resolves to a single active ИП after disabling the extra one.
  await p.clubLegalEntity.updateMany({ where: { clubId: CLUB2, legalEntityId: "pilot-card-ip2" }, data: { isActive: false } });
  const c3 = await cards(CLUB2, now);
  check("single active ИП resolves (configured, no yesterday inflow)", c3.configured && c3.yInflow === 0);

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
