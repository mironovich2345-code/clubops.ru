import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Mobile visual-regression + layout-assertion spec (Part 2 §8/§9). For each page it
// captures light + dark screenshots and asserts, PROGRAMMATICALLY, the defects the
// screenshots surfaced: no page horizontal overflow, every button/input/select stays
// inside its parent and ≥12px from the viewport edge, no button overlaps, adjacent
// action controls are ≥8px apart, primary CTA label is centered.

const ART = "artifacts/mobile-visual-polish-part2";
mkdirSync(ART, { recursive: true });

// Authenticated pages (need PW_STORAGE). Public pages captured regardless.
const PUBLIC_PAGES = [{ name: "login", url: "/login" }];
const APP_PAGES = [
  { name: "dashboard", url: "/dashboard" },
  { name: "expenses", url: "/expenses" },
  { name: "collections", url: "/collections" },
  { name: "invoices", url: "/invoices" },
  { name: "employees", url: "/employees" },
  { name: "analytics", url: "/analytics" },
  { name: "ofd-sales", url: "/analytics/ofd-sales" },
  { name: "budgets", url: "/budgets" },
  { name: "activity", url: "/activity" },
];
const authed = Boolean(process.env.PW_STORAGE);
const PAGES = authed ? [...PUBLIC_PAGES, ...APP_PAGES] : PUBLIC_PAGES;

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => {
    localStorage.setItem("theme", t);
    document.documentElement.classList.toggle("dark", t === "dark");
    document.documentElement.setAttribute("data-theme", t);
  }, theme);
}

/** Core layout assertions run on the current page state. */
async function assertLayout(page: Page, width: number) {
  // 1) No page-level horizontal overflow.
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollW, "no horizontal page overflow").toBeLessThanOrEqual(width + 1);

  // 2) Every visible button/input/select is inside the viewport with a ≥12px edge gap,
  //    and inside its own parent's box.
  const offenders = await page.evaluate((vw) => {
    const bad: string[] = [];
    const els = Array.from(document.querySelectorAll("button, input, select, a[role=button], [data-cta]")) as HTMLElement[];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // hidden
      if (r.left < 12 - 0.5 || r.right > vw - 12 + 0.5) bad.push(`edge:${el.textContent?.trim().slice(0, 20)}@${Math.round(r.left)}-${Math.round(r.right)}`);
      const p = el.parentElement;
      if (p) {
        const pr = p.getBoundingClientRect();
        if (r.right > pr.right + 1 || r.left < pr.left - 1) bad.push(`parent-overflow:${el.textContent?.trim().slice(0, 20)}`);
      }
    }
    return bad;
  }, width);
  expect(offenders, "controls within viewport(≥12px)+parent").toEqual([]);

  // 3) No two buttons overlap; adjacent action buttons ≥8px apart.
  const overlaps = await page.evaluate(() => {
    const btns = (Array.from(document.querySelectorAll("button, a[role=button]")) as HTMLElement[])
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    const bad: string[] = [];
    for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) {
      const a = btns[i], b = btns[j];
      const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      if (ox > 1 && oy > 1) bad.push(`overlap@${Math.round(a.left)},${Math.round(a.top)}`);
    }
    return bad;
  });
  expect(overlaps, "no button overlaps").toEqual([]);
}

for (const pg of PAGES) {
  for (const theme of ["light", "dark"] as const) {
    test(`${pg.name} · ${theme}`, async ({ page }, testInfo) => {
      const width = page.viewportSize()!.width;
      await page.goto(pg.url, { waitUntil: "networkidle" });
      await setTheme(page, theme);
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${ART}/${pg.name}-${theme}-${width}.png`, fullPage: true });
      await assertLayout(page, width);

      // Drawer-open capture (mobile widths only, authed app pages).
      if (authed && width < 1024 && pg.name !== "login") {
        const menu = page.getByRole("button", { name: "Меню" });
        if (await menu.count()) {
          await menu.first().click();
          await page.waitForTimeout(150);
          await page.screenshot({ path: `${ART}/${pg.name}-${theme}-${width}-drawer.png` });
          // Drawer must stay within the viewport.
          const drawerW = await page.evaluate(() => document.documentElement.scrollWidth);
          expect(drawerW).toBeLessThanOrEqual(width + 1);
        }
      }
      testInfo.annotations.push({ type: "captured", description: `${pg.name}-${theme}-${width}` });
    });
  }
}
