// Generates prisma/production/schema.prisma from prisma/schema.prisma by
// switching the datasource provider from sqlite (local beta) to postgresql
// (Railway). The models stay the single source of truth in prisma/schema.prisma.
//
// Run after changing the models:  node scripts/sync-prod-schema.mjs
// (wired up as `npm run prisma:sync-prod`).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEADER =
  "// GENERATED FILE — do not edit by hand.\n" +
  "// Source of truth: prisma/schema.prisma. Regenerate with `npm run prisma:sync-prod`.\n" +
  "// PostgreSQL variant used for Railway (production / review) deployments.\n\n";

/**
 * Pure transform: SQLite dev schema text -> PostgreSQL production schema text.
 * CRLF-safe — the input is normalised to LF first so the datasource-comment
 * replacement (and the whole output) behaves identically regardless of the
 * checkout's line endings. Exported so the deploy-config guard can regression-test
 * it on both LF and CRLF inputs without shelling out.
 */
export function toProductionSchema(originalText) {
  // Normalise to LF so a CRLF checkout does not defeat the comment regex (`.` and
  // `.*\n` never match a bare `\r`), and so the generated file has stable endings.
  const normalized = originalText.replace(/\r\n/g, "\n");
  if (!normalized.includes('provider = "sqlite"')) {
    throw new Error('Expected provider = "sqlite" in prisma/schema.prisma');
  }
  const swapped = normalized
    // datasource provider: sqlite -> postgresql
    .replace('provider = "sqlite"', 'provider = "postgresql"')
    // drop the local-only "SQLite" wording from the leading comment block
    .replace(
      /  \/\/ Temporarily on SQLite[\s\S]*?Switch back to "postgresql".*\n/,
      "  // PostgreSQL for Railway deployments (see DEPLOYMENT.md).\n",
    );
  return HEADER + swapped;
}

// CLI entrypoint (skipped when imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const source = resolve(root, "prisma/schema.prisma");
  const target = resolve(root, "prisma/production/schema.prisma");
  const output = toProductionSchema(readFileSync(source, "utf8"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output, "utf8");
  console.log(`Wrote ${target}`);
}
