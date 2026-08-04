// REM-05 — READ-ONLY profit/budget-fact reconciliation (§23). Imports & EXECUTES the
// ACTUAL services (calculateProfit / calculateBudgetFact) AND the migrated reader
// (getBudgetFactReportForScope) via jiti and compares them per company/month. NO
// corrections, NO writes. Proves the canonical budget-fact service and the Plan/Fact
// reader now agree, and reports the canonical profit for review.
//   node --env-file=.env scripts/reconcile-profit-budget-fact.mjs [--company=ID] [--month=YYYY-MM] [--json]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), { alias: { "@": SRC, "server-only": join(ROOT, "scripts", "_stubs", "server-only.cjs") }, interopDefault: true, esmResolve: true });
const { calculateProfit } = jiti("@/lib/finance/profit.ts");
const { calculateBudgetFact } = jiti("@/lib/finance/budget-fact.ts");
const { getBudgetFactReportForScope } = jiti("@/lib/budgets.ts");
const { prisma } = jiti("@/lib/prisma.ts");

const arg = (n) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : null; };
const JSON_ONLY = process.argv.includes("--json");
const ONLY_COMPANY = arg("company");
const ONLY_MONTH = arg("month");

function recentMonths(n) {
  // Deterministic: derive from the newest expenseDate in the DB is overkill; use a
  // fixed recent window around the data. Here we scan distinct budget months + a default.
  return null;
}

async function main() {
  const companies = await prisma.company.findMany({ where: ONLY_COMPANY ? { id: ONLY_COMPANY } : {}, select: { id: true, name: true } });
  const rows = [];
  let mismatches = 0;

  for (const co of companies) {
    const clubs = await prisma.club.findMany({ where: { companyId: co.id }, select: { id: true } });
    const clubIds = clubs.map((c) => c.id);
    if (!clubIds.length) continue;
    // Months to check: explicit, else the distinct budget + invoice-period months present.
    let months;
    if (ONLY_MONTH) months = [ONLY_MONTH];
    else {
      const b = await prisma.budget.findMany({ where: { companyId: co.id }, select: { month: true }, distinct: ["month"] });
      const inv = await prisma.invoice.findMany({ where: { companyId: co.id, expensePeriod: { not: null } }, select: { expensePeriod: true }, distinct: ["expensePeriod"] });
      months = [...new Set([...b.map((x) => x.month), ...inv.map((x) => x.expensePeriod)])].filter(Boolean);
    }
    for (const month of months) {
      const canonical = await calculateBudgetFact({ companyId: co.id, allowedClubIds: clubIds, month });
      const reader = await getBudgetFactReportForScope(co.id, clubIds, month);
      const readerFact = reader.reduce((a, r) => a + r.actualKopeks, 0);
      // The reader is per-category over budgeted categories only; compare the overlap:
      // sum of canonical fact for categories that the reader reports.
      const readerCats = new Set(reader.map((r) => r.category));
      const canonicalOnReaderCats = canonical.rows.filter((r) => readerCats.has(r.category)).reduce((a, r) => a + r.factKopeks, 0);
      const agree = canonicalOnReaderCats === readerFact;
      if (!agree) mismatches++;
      const profit = await calculateProfit({ companyId: co.id, allowedClubIds: clubIds, months: [month] });
      rows.push({ company: co.name, month, canonicalFactKopeks: canonical.recognizedFactKopeks, readerFactKopeks: readerFact, agreeOnReaderCats: agree, profitKopeks: profit.profitKopeks, revenueKopeks: profit.revenueKopeks });
    }
  }

  const out = { note: "read-only; canonical budget-fact vs migrated Plan/Fact reader + canonical profit", mismatches, rows };
  if (JSON_ONLY) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`Profit/budget-fact reconciliation — ${rows.length} company·month cell(s), ${mismatches} mismatch(es)`);
    for (const r of rows) console.log(`  ${r.company} ${r.month}: canonical fact=${(r.canonicalFactKopeks / 100).toLocaleString("ru")}₽  reader=${(r.readerFactKopeks / 100).toLocaleString("ru")}₽  ${r.agreeOnReaderCats ? "AGREE" : "DIFF"}  profit=${(r.profitKopeks / 100).toLocaleString("ru")}₽`);
    if (!rows.length) console.log("  (no company·month cells with data)");
  }
  await prisma.$disconnect();
  process.exit(0);
}
main().catch(async (e) => { console.error("reconcile failed:", String(e.message || e).slice(0, 200)); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
