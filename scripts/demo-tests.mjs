// Real PostgreSQL integration checks. Refuses every database outside the demo gate.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

if (existsSync(".env.demo.local")) process.loadEnvFile(".env.demo.local");
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": resolve("src"), "server-only": resolve("scripts/_stubs/server-only.cjs") }, interopDefault: true });
const { demoConfig } = jiti("@/lib/demo/config.ts");
demoConfig();
const { prisma } = jiti("@/lib/prisma.ts");
const { seedDemoTenant } = jiti("@/lib/demo/fixtures.ts");
const { purgeDemoVisit } = jiti("@/lib/demo/visits.ts");
const { loadRecognizedExpenses } = jiti("@/lib/finance/recognized-expense.ts");
const visits = [];
let checks = 0;
function passed(name) { checks++; console.log(`PASS ${name}`); }
function check(name, fn) { fn(); passed(name); }
try {
  for (const patch of [ { DEMO_MODE: "false" }, { APP_ENVIRONMENT: "production" }, { APP_URL: "https://clubops.ru" }, { DEMO_ALLOWED_HOST: "clubops.ru" }, { DATABASE_URL: "file:./dev.db" }, { DATABASE_URL: "postgresql://postgres@localhost/production" }, { SMTP_USER: "real-user" }, { AI_PROVIDER: "yandex" }, { OFD_INTEGRATIONS_ENABLED: "true" } ]) {
    check(`Fail-closed config: ${Object.keys(patch)[0]}`, () => assert.throws(() => demoConfig({ ...process.env, ...patch })));
  }
  const { sendOtpEmail } = jiti("@/lib/email.ts");
  await assert.rejects(() => sendOtpEmail("synthetic@visitor.invalid", "000000", 5, "demo-qa"), /Демо/);
  passed("SMTP cannot send in demo even via direct transport call");
  const { registerAction } = jiti("@/app/auth-actions.ts");
  await assert.rejects(() => registerAction(undefined, new FormData()), /Демо/);
  passed("Direct registration action fails closed");
  for (let n = 0; n < 2; n++) {
    const visit = await prisma.$transaction(async (tx) => {
      const seed = await seedDemoTenant(tx);
      return tx.demoVisit.create({ data: { tokenHash: randomBytes(32).toString("hex"), companyId: seed.companyId, usersJson: JSON.stringify(seed.users), clubsJson: JSON.stringify(seed.clubs), expiresAt: new Date(Date.now() + 60_000) } });
    }, { timeout: 60_000 });
    visits.push(visit);
  }
  for (const v of visits) {
    const companyId = v.companyId;
    const sums = await prisma.ofdDailySalesSummary.aggregate({ where: { companyId }, _sum: { incomeTotalKopeks: true, returnTotalKopeks: true, netTotalKopeks: true } });
    check("Fiscal gross, returns and net", () => assert.deepEqual(sums._sum, { incomeTotalKopeks: 432_000_000, returnTotalKopeks: 12_000_000, netTotalKopeks: 420_000_000 }));
    const plan = await prisma.salesPlan.aggregate({ where: { companyId, planType: "total" }, _sum: { targetAmountKopeks: true } });
    check("Revenue plan and linear 15-day forecast", () => { assert.equal(plan._sum.targetAmountKopeks, 960_000_000); assert.equal(420_000_000 * 2 / 960_000_000, .875); });
    const employees = await prisma.clubEmployee.count({ where: { companyId, status: "active" } });
    check("48 active synthetic employees", () => assert.equal(employees, 48));
    const clubIds = JSON.parse(v.clubsJson);
    const recognized = await loadRecognizedExpenses({ companyId, allowedClubIds: clubIds, months: ["2026-11"], db: prisma });
    check("Canonical expense reader: 1,680,000 RUB", () => assert.equal(recognized.totalKopeks, 168_000_000));
    const budget = await prisma.budget.aggregate({ where: { companyId }, _sum: { limitAmountKopeks: true } });
    check("Expense plan 3,000,000 RUB", () => assert.equal(budget._sum.limitAmountKopeks, 300_000_000));
    const invoice = await prisma.invoice.aggregate({ where: { companyId }, _sum: { amountKopeks: true } });
    const payments = await prisma.invoicePayment.aggregate({ where: { companyId, status: "confirmed" }, _sum: { amountKopeks: true } });
    check("Invoice ledger: total 1,200,000 / paid 600,000 RUB", () => { assert.equal(invoice._sum.amountKopeks, 120_000_000); assert.equal(payments._sum.amountKopeks, 60_000_000); });
    const users = await prisma.user.findMany({ where: { id: { in: Object.values(JSON.parse(v.usersJson)) } } });
    check("No password or real email/phone in visitor users", () => assert(users.every(u => !u.passwordHash && !u.phone && u.email.endsWith("@visitor.invalid"))));
    const grants = await prisma.clubUserAccess.findMany({ where: { userId: JSON.parse(v.usersJson).manager } });
    check("Manager has a single branch grant", () => assert.equal(grants.length, 1));
    const doc = await prisma.expenseDocument.findFirst({ where: { companyId } });
    const { readExpenseDocument } = jiti("@/lib/expense-document-storage.ts");
    const bytes = await readExpenseDocument(doc.storageKey);
    check("Synthetic document passes the original storage key/read contract", () => assert.match(bytes?.toString("ascii") ?? "", /^%PDF/));
    const connections = await prisma.ofdConnection.findMany({ where: { companyId } });
    check("OFD connectors inactive and credential-free", () => assert(connections.every(c => !c.isActive && !c.loginEncrypted && !c.passwordEncrypted && c.serverBaseUrl === "https://ofd.invalid")));
  }
  const first = visits.shift();
  await assert.rejects(() => prisma.$transaction(async tx => {
    await tx.expenseCategory.createMany({ data: Array.from({ length: 1001 }, (_, i) => ({ companyId: first.companyId, key: `${first.id}-quota-${i}`, name: "Синтетическая категория" })) });
  }, { timeout: 30_000 }), /DEMO_TENANT_ROW_LIMIT/);
  passed("Database insert quota rejects oversized tenant import");
  await prisma.$transaction(tx => purgeDemoVisit(tx, first), { timeout: 60_000 });
  const firstRows = await prisma.company.count({ where: { id: first.companyId } });
  const secondRows = await prisma.company.count({ where: { id: visits[0].companyId } });
  check("Reset/purge isolation: visitor B survives A deletion", () => { assert.equal(firstRows, 0); assert.equal(secondRows, 1); });
  const orphanReceipts = await prisma.ofdReceiptImport.count({ where: { companyId: first.companyId } });
  check("TTL cleanup removes unlinked OFD rows", () => assert.equal(orphanReceipts, 0));
  console.log(`${checks} checks passed`);
} finally {
  for (const v of visits) await prisma.$transaction(tx => purgeDemoVisit(tx, v), { timeout: 60_000 });
  await prisma.$disconnect();
}
