import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

process.loadEnvFile(".env.demo.local");
const require = createRequire(import.meta.url);
const { chromium } = require("playwright"); // QA dependency; install outside the app if absent
const { demoConfig } = require("jiti")(import.meta.url)("../src/lib/demo/config.ts");
const { origin } = demoConfig();
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const browser = await chromium.launch({ headless: true, ...(process.env.DEMO_CHROMIUM_PATH ? { executablePath: process.env.DEMO_CHROMIUM_PATH } : {}) });
const failures = [];
const externals = [];
const contexts = [];
let checks = 0;
const pass = (name) => { checks++; console.log(`PASS ${name}`); };
const routes = ["/dashboard", "/analytics", "/analytics/ofd-sales", "/expenses", "/invoices", "/employees", "/payroll", "/budgets", "/refunds", "/payments", "/settings", "/users", "/collections"];
const screenshotDir = "artifacts/demo-browser";
mkdirSync(screenshotDir, { recursive: true });

// Use the real browser cookie policy. Playwright's APIRequestContext does not
// treat loopback HTTP as secure, while Chromium does for Secure session cookies.
async function browserGet(page, path) {
  return page.evaluate(async p => {
    const response = await fetch(p, { credentials: "same-origin" });
    return { status: response.status, url: response.url, text: await response.text() };
  }, path);
}

async function visitor(ip) {
  const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { "x-forwarded-for": ip } });
  contexts.push(context);
  context.on("request", req => { if (new URL(req.url()).origin !== origin) externals.push(req.url()); });
  const page = await context.newPage();
  page.on("pageerror", e => failures.push(e.message));
  await page.goto("/demo");
  await page.getByRole("button", { name: "Посмотреть демо", exact: true }).click();
  await page.waitForURL("**/dashboard?month=2026-11");
  await page.locator("h1").waitFor();
  const companyId = (await context.cookies()).find(c => c.name === "scope_company").value;
  return { context, page, companyId };
}
async function switchRole(page, role, branch = "0") {
  await page.goto("/demo");
  await page.locator('select[name="role"]').selectOption(role);
  await page.locator('select[name="club"]').selectOption(branch);
  await page.getByRole("button", { name: "Посмотреть демо", exact: true }).click();
  await page.waitForURL(role === "accountant" ? "**/workspace" : "**/dashboard?month=2026-11");
  await page.waitForLoadState("networkidle");
}
try {
  const ready = await (await fetch(`${origin}/api/health/ready`)).json();
  assert.equal(ready.status, "ready"); pass("PostgreSQL readiness");
  const csrf = await fetch(`${origin}/api/demo/session`, { method: "POST", headers: { Origin: "https://foreign.invalid" }, body: "role=owner" });
  assert(csrf.status >= 400); pass("Cross-origin admission denied");
  const qaIp = 20 + (process.pid % 100) * 2;
  const a = await visitor(`192.0.2.${qaIp}`);
  const b = await visitor(`192.0.2.${qaIp + 1}`);
  assert.notEqual(a.companyId, b.companyId); pass("Two browsers receive separate tenants");
  // Financial summary must never be injected by the shared layout into other modules.
  assert.equal(await a.page.getByRole("region", { name: "Демонстрационный период" }).count(), 1);
  await a.page.goto("/refunds");
  assert.equal(await a.page.getByRole("region", { name: "Демонстрационный период" }).count(), 0);
  assert.equal(await a.page.locator('aside[aria-label="Демонстрационная версия"]').count(), 1);
  pass("Financial summary only on dashboard; compact demo strip on other screens");
  await a.page.goto("/dashboard?month=2026-11");
  if (process.env.DEMO_QA_WORKFLOWS_ONLY === "1") console.log("SKIP responsive matrix (workflow-only diagnostic run)");
  for (const width of process.env.DEMO_QA_WORKFLOWS_ONLY === "1" ? [] : [375, 390, 768, 1024, 1440]) {
    await a.page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      const response = await a.page.goto(route, { waitUntil: "networkidle" });
      assert.equal(response.status(), 200, route);
      await a.page.locator("h1").waitFor();
      assert.match(response.headers()["x-robots-tag"], /noindex/);
      assert.equal(await a.page.locator('aside[aria-label="Демонстрационная версия"]').count(), 1);
      const overflow = await a.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      assert.equal(overflow, false, `${route} at ${width}px has document overflow`);
      await a.page.screenshot({ path: `${screenshotDir}/${route.replaceAll("/", "_")}-${width}.png`, fullPage: true });
    }
    pass(`13 original screens at ${width}px`);
  }
  const foreignInvoice = await db.invoice.findFirst({ where: { companyId: b.companyId } });
  const foreignResult = await browserGet(a.page, `/invoices/${foreignInvoice.id}`);
  // App Router can stream notFound() after committing HTTP 200; assert the
  // not-found outcome and absence of protected data, not just a status code.
  const foreignHtml = foreignResult.text;
  assert.match(foreignHtml, /This page could not be found|NEXT_HTTP_ERROR_FALLBACK;404/);
  assert(!foreignHtml.includes(foreignInvoice.invoiceNumber)); pass("Visitor A cannot read visitor B invoice");
  for (const role of ["general_director", "regional_director", "manager", "accountant"]) {
    await switchRole(a.page, role, "1");
    assert.equal((await a.context.cookies()).find(c => c.name === "scope_company").value, a.companyId);
    pass(`Ordinary scoped session: ${role}`);
  }
  assert.equal(await a.page.getByRole("region", { name: "Демонстрационный период" }).count(), 0);
  const invoice = await db.invoice.findFirst({ where: { companyId: a.companyId, status: "partially_paid" } });
  await a.page.goto(`/invoices/${invoice.id}`);
  await a.page.locator('[name="paymentDate"]').fill("2026-11-15");
  const payForm = a.page.getByRole("button", { name: "Сохранить оплату", exact: true }).locator("xpath=ancestor::form");
  const foreignPaymentCount = await db.invoicePayment.count({ where: { invoiceId: foreignInvoice.id } });
  await payForm.locator('[name="invoiceId"]').evaluate((el, value) => { el.value = value; }, foreignInvoice.id);
  await a.page.getByRole("button", { name: "Сохранить оплату", exact: true }).click();
  await a.page.getByText("Счёт не найден или нет доступа", { exact: true }).waitFor();
  assert.equal(await db.invoicePayment.count({ where: { invoiceId: foreignInvoice.id } }), foreignPaymentCount);
  pass("Tampered payment action cannot write to another visitor tenant");
  await payForm.locator('[name="invoiceId"]').evaluate((el, value) => { el.value = value; }, invoice.id);
  await a.page.getByRole("button", { name: "Сохранить оплату", exact: true }).click();
  await a.page.waitForTimeout(1000);
  assert.equal((await db.invoice.findUnique({ where: { id: invoice.id } })).status, "paid");
  pass("Accountant records a real invoice-ledger payment");
  const expense = await db.expense.findFirst({ where: { companyId: a.companyId, status: "pending_accountant_verification" } });
  const document = await db.expenseDocument.findFirst({ where: { expenseId: expense.id } });
  const pdf = await browserGet(a.page, `/api/expenses/${expense.id}/documents/${document.id}`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.text, /^%PDF/); pass("Scoped synthetic receipt PDF is readable");
  await a.page.goto(`/expenses/${expense.id}`);
  await a.page.getByRole("button", { name: "Проверить (бухгалтерия)", exact: true }).click();
  await a.page.waitForTimeout(1000);
  assert.equal((await db.expense.findUnique({ where: { id: expense.id } })).status, "verified");
  pass("Accountant verifies a documented expense through original workflow");
  await switchRole(a.page, "manager", "1");
  const grant = await db.clubUserAccess.findMany({ where: { userId: JSON.parse((await db.demoVisit.findUnique({ where: { companyId: a.companyId } })).usersJson).manager } });
  assert.equal(grant.length, 1); pass("Manager switching grants exactly one branch");
  const denied = await browserGet(a.page, "/analytics/ofd-sales");
  assert(!denied.url.endsWith("/analytics/ofd-sales")); pass("Manager cannot enter role-restricted OFD analytics");
  await a.page.goto("/demo");
  await Promise.all([
    a.page.waitForResponse(r => r.url().endsWith("/api/demo/session") && r.request().method() === "POST"),
    a.page.getByRole("button", { name: "Сбросить данные и начать заново", exact: true }).click(),
  ]);
  await a.page.waitForURL("**/dashboard?month=2026-11");
  await a.page.waitForFunction(() => document.readyState === "complete");
  await a.page.waitForLoadState("networkidle");
  assert.equal(await db.company.count({ where: { id: a.companyId } }), 0);
  assert.equal(await db.company.count({ where: { id: b.companyId } }), 1); pass("Reset deletes only A tenant; B stays intact");
  const newCompany = (await a.context.cookies()).find(c => c.name === "scope_company").value;
  const v = await db.demoVisit.findUnique({ where: { companyId: newCompany } });
  await db.session.updateMany({ where: { userId: { in: Object.values(JSON.parse(v.usersJson)) } }, data: { expiresAt: new Date(0) } });
  const expired = await browserGet(a.page, "/dashboard");
  assert(new URL(expired.url).pathname === "/demo"); pass("Expired ordinary session cannot access the app");
  await db.demoVisit.update({ where: { id: v.id }, data: { expiresAt: new Date(0) } });
  const cleanup = await fetch(`${origin}/api/demo/cleanup`, { method: "POST", headers: { Authorization: `Bearer ${process.env.DEMO_CLEANUP_SECRET}`, Origin: origin } });
  assert.equal(cleanup.status, 200);
  assert.equal(await db.company.count({ where: { id: newCompany } }), 0);
  assert.equal(await db.company.count({ where: { id: b.companyId } }), 1);
  pass("Authenticated TTL cleanup removes expired tenant after real mutations");
  assert.deepEqual(externals, []); pass("Browser makes no external requests");
  assert.deepEqual(failures, []); pass("No browser JavaScript errors");
  console.log(`${checks} browser checks passed`);
} finally {
  // Retain no active QA tenants between runs, including a run that failed.
  for (const context of contexts) {
    const id = (await context.cookies()).find(c => c.name === "scope_company")?.value;
    if (id) await db.demoVisit.updateMany({ where: { companyId: id }, data: { expiresAt: new Date(0) } });
  }
  if (process.env.DEMO_CLEANUP_SECRET) await fetch(`${origin}/api/demo/cleanup`, { method: "POST", headers: { Authorization: `Bearer ${process.env.DEMO_CLEANUP_SECRET}`, Origin: origin } });
  for (const c of contexts) await c.close();
  await browser.close();
  await db.$disconnect();
}
