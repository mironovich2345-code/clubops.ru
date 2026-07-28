// Build an HTML contact sheet from the captured screenshots for quick manual review
// (Part 2 §8). Offline: reads artifacts/mobile-visual-polish-part2/*.png → index.html.
//   node tests/visual/contact-sheet.mjs
import { readdirSync, writeFileSync, existsSync } from "node:fs";

const DIR = "artifacts/mobile-visual-polish-part2";
if (!existsSync(DIR)) { console.error(`No artifacts dir ${DIR} — run the Playwright capture first.`); process.exit(1); }
const pngs = readdirSync(DIR).filter((f) => f.endsWith(".png")).sort();
if (pngs.length === 0) { console.error("No .png screenshots yet — run: npx playwright test --config playwright.config.ts"); process.exit(1); }

const cards = pngs.map((f) => `<figure><img loading="lazy" src="./${f}" alt="${f}"><figcaption>${f}</figcaption></figure>`).join("\n");
const html = `<!doctype html><meta charset="utf-8"><title>Mobile visual polish — Part 2 contact sheet</title>
<style>body{font:14px system-ui;margin:16px;background:#0b1220;color:#e2e8f0}h1{font-size:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
figure{margin:0;background:#111827;border:1px solid #1f2937;border-radius:8px;padding:8px}
img{width:100%;height:auto;border-radius:4px;background:#fff}figcaption{margin-top:6px;font-size:12px;color:#94a3b8;word-break:break-all}</style>
<h1>Mobile visual polish — Part 2 (${pngs.length} screenshots)</h1>
<div class="grid">${cards}</div>`;
writeFileSync(`${DIR}/index.html`, html);
console.log(`Wrote ${DIR}/index.html (${pngs.length} screenshots)`);
