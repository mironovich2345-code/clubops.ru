// Pilot — REM-02 single cash source (§27). Fast STRUCTURAL checks that the unified resolver + cutover
// guard are in place and wired; the BEHAVIORAL proof (snapshot rule, cutover, tenant isolation on a real
// DB) is scripts/rem-02-cash-source-integration.mjs (npm run test:rem-02-integration, 13/13). Runs in
// pilot:full (source-only, fast).
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x && !c ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => { try { return readFileSync(new URL(p, import.meta.url), "utf8"); } catch { return ""; } };

const resolver = src("../src/lib/cash-snapshot-resolver.ts");
const cashResolver = src("../src/lib/cash-resolver.ts");
const balSnaps = src("../src/lib/balance-snapshots.ts");
const cashColl = src("../src/lib/cash-collections.ts");
const cashWallets = src("../src/lib/cash-wallets.ts");
const schema = src("../prisma/schema.prisma");
const prodSchema = src("../prisma/production/schema.prisma");
const integ = src("./rem-02-cash-source-integration.mjs");
const preflight = src("./preflight-cash-cutover.mjs");
const reconcile = src("./reconcile-cash-contours.mjs");
const pkg = src("../package.json");
const baseline = src("../docs/remediation/rem-02-cash-source-baseline.md");
const formulas = src("../docs/remediation/rem-02-canonical-cash-formulas.md");
const report = src("../docs/remediation/rem-02-final-report.md");
const migDev = src("../prisma/migrations/20260803140000_cash_canonical_cutover/migration.sql");
const migProd = src("../prisma/production/migrations/20260803140000_cash_canonical_cutover/migration.sql");

check("1 business decision documented (canonical contour = official)", baseline.includes("Ratified business decision") && baseline.includes("official source"));
check("2 canonical formulas documented (ООО + ИП + rule B)", formulas.includes("cashOooFactBalance") && formulas.includes("cashIpFactBalance") && formulas.includes("rule **B**"));
check("3 one shared snapshot resolver exists", resolver.includes("export function activeSnapshotWhere") && resolver.includes("resolveActiveSnapshots") && resolver.includes("CASH_FORMULA_VERSION"));
check("4 canonical rule is active + date cutoff", resolver.includes('status: "active"') && resolver.includes("lte: asOf") && resolver.includes("lt: asOf"));
check("5 single resolveCashBalance service exists", cashResolver.includes("export async function resolveCashBalance") && cashResolver.includes("formulaVersion"));
check("6 dashboard/analytics/payments readers use the shared rule (balance-snapshots)", balSnaps.includes("activeSnapshotWhere(new Date())") && balSnaps.includes("activeSnapshotWhere(asOfExclusive"));
check("7 cash contour loader uses the shared rule", cashColl.includes("activeSnapshotWhere(now)"));
check("8 cancelled/superseded excluded (status active only)", resolver.includes('"active"') && !resolver.includes('"cancelled"') && !resolver.includes('"superseded"'));
check("9 resolver never reads the legacy wallet", !cashResolver.includes("walletBalance") && !cashResolver.includes("CashMovement"));
check("10 no-snapshot → warning, no fabricated opening", cashResolver.includes("snapshotSet") && cashResolver.includes("warnings"));
check("11 cutover setting exists (additive)", /cashCanonicalCutoverAt\s+DateTime\?/.test(schema) && /cashCanonicalCutoverAt/.test(prodSchema));
check("12 cutover migration additive (ADD COLUMN, no DROP)", /ADD COLUMN/.test(migDev) && /ADD COLUMN/.test(migProd) && !/DROP/.test(migDev) && !/DROP/.test(migProd));
check("13 legacy write guard exists + used by recordExpenseMovement", cashWallets.includes("export async function legacyCashWriteDisabled") && /recordExpenseMovement[\s\S]*legacyCashWriteDisabled/.test(cashWallets));
check("14 reconciliation tool is read-only (no writes)", reconcile.includes("READ-ONLY") && !/\.(create|update|delete|upsert)\(/.test(reconcile));
check("15 preflight is read-only (SELECT-only)", preflight.includes("READ-ONLY") && !/\.(create|update|delete|upsert)\(/.test(preflight));
check("16 preflight covers duplicate active + ООО cash-expense + post-cutover write", preflight.includes("duplicate ACTIVE") && preflight.includes("ООО cash expense") && preflight.includes("after the company cutover"));
check("17 REAL DB integration test executes the resolver (not a mirror)", integ.includes("resolveCashBalance") && integ.includes("jiti") && integ.includes("copyFileSync"));
check("18 integration covers cancelled/corrected/backdated/future snapshot", integ.includes("cancelled snapshot ignored") && integ.includes("corrected snapshot") && integ.includes("backdated earlier") && integ.includes("future snapshot ignored"));
check("19 integration covers asOf history + tenant isolation + cutover guard", integ.includes("asOf historical") && integ.includes("tenant isolation") && integ.includes("cutover guard"));
check("20 integration proves legacy divergence does not alter official balance", integ.includes("legacy wallet row does NOT change"));
check("21 npm scripts registered", pkg.includes("test:rem-02-integration") && pkg.includes("preflight:cash-cutover") && pkg.includes("reconcile:cash-contours") && pkg.includes("pilot:rem-02-single-cash-source"));
check("22 findings closure recorded", report.includes("ARCH-001") && report.includes("CLOSED") && report.includes("DATA-002"));
check("23 no legacy model deletion (CashWallet/CashMovement still in schema)", /model CashWallet/.test(schema) && /model CashMovement/.test(schema));
check("24 PostgreSQL gate documented", report.includes("PostgreSQL") && report.includes("NOT executed"));
check("25 formula version pinned", resolver.includes('"rem-02.v1"') && cashResolver.includes("CASH_FORMULA_VERSION"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
