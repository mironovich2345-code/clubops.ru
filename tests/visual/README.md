# Mobile visual-regression harness (Part 2 §8)

Real, runnable Playwright harness that captures screenshots + runs bounding-box layout
assertions across the required widths (320/375/390/430/768/1440) in light & dark.

> **Status:** NOT executed in the dev sandbox — it has **no network** (npm/browser install
> blocked) and the app is behind **email-OTP login** (no inbox available headless). Run it
> locally / in CI where you can install Playwright and provide an authenticated session.

## One-time setup (online)

```bash
npm i -D @playwright/test
npx playwright install chromium
```

## Auth (the app requires password + email OTP)

Log in once in a headed browser and save the session state:

```bash
# 1. Start the app
npm run dev            # or: npm run start (after build)
# 2. Save an authenticated storageState (log in manually when the browser opens)
npx playwright open http://localhost:3000/login   # sign in, then in the Playwright
                                                   # inspector: Save storage state →
                                                   # tests/visual/.auth/state.json
```

Without `PW_STORAGE` only the public `/login` page is captured (proves the harness works).

## Run

```bash
BASE_URL=http://localhost:3000 PW_STORAGE=tests/visual/.auth/state.json \
  npx playwright test --config playwright.config.ts

node tests/visual/contact-sheet.mjs   # build artifacts/mobile-visual-polish-part2/index.html
```

Screenshots → `artifacts/mobile-visual-polish-part2/<page>-<theme>-<width>.png`
(+ `-drawer.png`). Open `artifacts/mobile-visual-polish-part2/index.html` to review.

## What the spec asserts (programmatically, §8/§9)

- `document.scrollWidth <= viewport width` (no horizontal page overflow);
- every visible button/input/select is inside its parent and ≥12px from the viewport edge;
- no two buttons overlap; (adjacent action gap covered by the edge/parent checks);
- drawer stays within the viewport when opened.

Pages: login, dashboard, expenses, collections, invoices, employees, analytics, ofd-sales,
budgets, activity — each in light and dark, mobile widths also drawer-open.
