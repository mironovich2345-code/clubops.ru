import { defineConfig } from "@playwright/test";

// Real mobile visual-regression harness (Part 2 §8). Runs the app at BASE_URL and
// captures screenshots + bounding-box assertions across the required widths in light
// and dark. Auth is provided via a saved storageState (PW_STORAGE) — the app is behind
// email-OTP, so log in once in a headed browser and save state (see tests/visual/README.md).
//
//   BASE_URL=http://localhost:3000 PW_STORAGE=tests/visual/.auth/state.json \
//     npx playwright test --config playwright.config.ts
export const WIDTHS: [number, number][] = [
  [320, 568],
  [375, 667],
  [390, 844],
  [430, 932],
  [768, 1024],
  [1440, 900],
];

export default defineConfig({
  testDir: "./tests/visual",
  outputDir: "./artifacts/mobile-visual-polish-part2/_output",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "artifacts/mobile-visual-polish-part2/report", open: "never" }]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    storageState: process.env.PW_STORAGE || undefined,
    deviceScaleFactor: 2,
    colorScheme: "light",
  },
  projects: WIDTHS.map(([w, h]) => ({
    name: `${w}x${h}`,
    use: { viewport: { width: w, height: h } },
  })),
});
