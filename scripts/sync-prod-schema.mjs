// Generates prisma/production/schema.prisma from prisma/schema.prisma by
// switching the datasource provider from sqlite (local beta) to postgresql
// (Railway). The models stay the single source of truth in prisma/schema.prisma.
//
// Run after changing the models:  node scripts/sync-prod-schema.mjs
// (wired up as `npm run prisma:sync-prod`).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "prisma/schema.prisma");
const target = resolve(root, "prisma/production/schema.prisma");

const original = readFileSync(source, "utf8");

if (!original.includes('provider = "sqlite"')) {
  throw new Error('Expected provider = "sqlite" in prisma/schema.prisma');
}

const header =
  "// GENERATED FILE — do not edit by hand.\n" +
  "// Source of truth: prisma/schema.prisma. Regenerate with `npm run prisma:sync-prod`.\n" +
  "// PostgreSQL variant used for Railway (production / review) deployments.\n\n";

const swapped = original
  // datasource provider: sqlite -> postgresql
  .replace('provider = "sqlite"', 'provider = "postgresql"')
  // drop the local-only "SQLite" wording from the leading comment block
  .replace(
    /  \/\/ Temporarily on SQLite[\s\S]*?Switch back to "postgresql".*\n/,
    "  // PostgreSQL for Railway deployments (see DEPLOYMENT.md).\n",
  );

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, header + swapped, "utf8");

console.log(`Wrote ${target}`);
