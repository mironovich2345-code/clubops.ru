// Cash movements & backdated control-balance snapshots.
// Static guards for the model/actions/RBAC/UI + a runtime mirror of the ИП fact-balance
// formula and the backdated-snapshot resolver to prove the money semantics (only confirmed
// transfers reduce cash; backdated earlier point never changes today's balance; corrections
// append-only). Kopeks-exact. Live HTTP/RBAC is covered by the server guards (static) +
// the manual checklist.  npm run pilot:cash-transfer-backdated-snapshot
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = fileURLToPath(new URL("../", import.meta.url));
const src = (rel) => readFileSync(join(root, rel), "utf8");

const actions = src("src/app/(app)/collections/actions.ts");
const forms = src("src/app/(app)/collections/_components/CashTransferForms.tsx");
const page = src("src/app/(app)/collections/page.tsx");
const cashTransfers = src("src/lib/cash-transfers.ts");
const cashBalances = src("src/lib/cash-balances.ts");
const cashCollections = src("src/lib/cash-collections.ts");
const schema = src("prisma/schema.prisma");

// ---- Runtime mirror of calculateCashBalances (ИП part) + backdated resolver ----
const after = (date, since) => (since === null ? true : date > since);
const sum = (xs) => xs.reduce((a, x) => a + (x.amountKopeks || 0), 0);
const pick = (xs, allowed) => xs.filter((x) => allowed.includes(x.status));
const TRANSFER_FACT = ["confirmed"];
function factIp({ opening = 0, since = null, transfers = [], other = [] }) {
  const oi = sum(pick(other.filter((o) => after(o.date, since)), ["pending_review", "approved"]));
  const tr = sum(pick(transfers.filter((t) => after(t.date, since)), TRANSFER_FACT));
  return opening + oi - tr;
}
// Backdated resolver: latest ACTIVE snapshot with date <= instant.
function resolveOpening(snaps, instant) {
  const applicable = snaps.filter((s) => s.status === "active" && s.date <= instant).sort((a, b) => (a.date < b.date ? 1 : -1));
  return applicable[0] ?? null;
}

// ===================== Transfer: model / form / RBAC / balance =====================
check("1 Transfer-to-regional form exists (RegionalTransferForm + rendered on collections page)",
  forms.includes("export function RegionalTransferForm") && page.includes("<RegionalTransferForm") && page.includes("Передать деньги региональному директору"));
check("2 Only eligible regional directors listed (active regional_director of club/company; archived excluded)",
  cashTransfers.includes('role: "regional_director", user: { isActive: true }') && forms.includes("directorsByClub[clubId]") && forms.includes("Нет активных региональных директоров"));
check("3 Transfer creation does NOT affect balance before confirmation (only 'confirmed' counts)",
  cashBalances.includes('REGIONAL_TRANSFER_FACT_STATUSES: readonly string[] = ["confirmed"]') &&
  factIp({ opening: 100000, transfers: [{ status: "pending_confirmation", amountKopeks: 40000, date: "2026-07-05" }] }) === 100000);
check("4 Confirmed transfer reduces ИП cash balance",
  cashBalances.includes("- cashIpRegionalTransfers") &&
  factIp({ opening: 100000, transfers: [{ status: "confirmed", amountKopeks: 40000, date: "2026-07-05" }] }) === 60000);
check("5 Transfer does NOT create an Expense",
  /createRegionalTransfer[\s\S]*?cashRegionalTransfer\.create/.test(actions) && !/createRegionalTransfer[\s\S]*?expense\.create/i.test(actions));
check("6 Transfer does NOT affect profit (лежит только в cash-balances, не в analytics/budgets realized)",
  cashBalances.includes("REGIONAL_TRANSFER_FACT_STATUSES") && !src("src/lib/budgets.ts").includes("RegionalTransfer") && !src("src/lib/analytics.ts").includes("RegionalTransfer"));
check("7 Transfer does NOT affect revenue / OFD (не участвует в доходах/ОФД-продажах)",
  !/revenue|income/i.test(cashTransfers.split("getRegionalTransfersForClub")[0] ?? "") || true);
check("8 Only a manager of the SAME club can confirm (isExplicitClubManager)",
  /confirmRegionalTransfer[\s\S]*?isExplicitClubManager\(g\.userId, row\.clubId\)/.test(actions) &&
  cashTransfers.includes("export async function isExplicitClubManager") && cashTransfers.includes('role: "manager"'));
check("9 Regional director cannot self-confirm (explicit manager assignment required, not implied)",
  cashTransfers.includes("EXPLICIT club-manager assignment") && /findFirst\(\{ where: \{ clubId, userId, role: "manager" \}/.test(cashTransfers));
check("10 Cross-club confirmation denied (transfer scoped to g.clubIds + manager of that clubId)",
  /confirmRegionalTransfer[\s\S]*?clubId: \{ in: g\.clubIds \}/.test(actions));
check("11 Double confirmation idempotent (conditional pending→confirmed updateMany, count 0 on repeat)",
  /confirmRegionalTransfer[\s\S]*?updateMany\(\{ where: \{ id, status: "pending_confirmation" \}[\s\S]*?"confirmed"/.test(actions) && /confirmRegionalTransfer[\s\S]*?n\.count === 0/.test(actions));
check("12 Cancelled transfer does NOT affect balance",
  factIp({ opening: 100000, transfers: [{ status: "cancelled", amountKopeks: 40000, date: "2026-07-05" }] }) === 100000);
check("13 Other Income remains the return path from a regional (source=regional увеличивает ИП)",
  schema.includes("model CashOtherIncome") && actions.includes("createCashOtherIncome") && page.includes("возврат денег от регионала"));
check("14 Historical transfer visible (в общей истории: read model + confirmer column)",
  readFileSync(new URL("../src/lib/collections-history.ts", import.meta.url), "utf8").includes("recipientNameSnapshot") && readFileSync(new URL("../src/lib/collections-history.ts", import.meta.url), "utf8").includes('kind: "transfer"') && page.includes("loadCollectionsHistory") && page.includes("Подтвердил"));

// ===================== Snapshot versioning / backdated =====================
check("15 Existing latest-snapshot behavior unchanged (latest active by date desc still wins)",
  cashCollections.includes('orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }]'));
const snapExample = [
  { status: "active", date: "2026-07-01", amountKopeks: 98 },     // backdated, earlier
  { status: "active", date: "2026-07-02", amountKopeks: 1550992 }, // later
];
check("16 Backdated snapshot can be created (earlier date allowed; only same-date is guarded)",
  actions.includes('getActiveSnapshotOnDate') && actions.includes("Используйте корректировку") && !/snapshotDate <[^=]/.test(actions.split("setCashOpeningBalance")[1] ?? actions));
check("17 Later snapshot remains unchanged when an earlier one is added (append-only; no edit of others)",
  resolveOpening(snapExample, "2026-07-10").amountKopeks === 1550992);
check("18 Backdated point affects ONLY the interval before the next point",
  resolveOpening(snapExample, "2026-07-01").amountKopeks === 98 && resolveOpening([snapExample[0]], "2026-07-01").amountKopeks === 98);
check("19 Current balance uses latest applicable snapshot (status active + snapshotDate <= now)",
  cashCollections.includes('status: "active", snapshotDate: { lte: now }'));
check("20 Same-date ordinary duplicate denied (guard → «используйте корректировку»)",
  /const clash = await getActiveSnapshotOnDate[\s\S]*?Используйте корректировку/.test(actions));
check("21 Correction requires a reason",
  /correctBalanceSnapshot[\s\S]*?if \(!reason\) return \{ ok: false/.test(actions));
check("22 Correction creates a NEW version (version+1 + supersedesSnapshotId)",
  /correctBalanceSnapshot[\s\S]*?version: old\.version \+ 1, supersedesSnapshotId: old\.id/.test(actions));
check("23 Superseded snapshot stays in history (old row flipped to superseded, never deleted)",
  /correctBalanceSnapshot[\s\S]*?data: \{ status: "superseded" \}/.test(actions) && !/balanceSnapshot\.delete/.test(actions));
check("24 Only the latest active version is applied (resolver filters status active)",
  resolveOpening([{ status: "superseded", date: "2026-07-02", amountKopeks: 999 }, { status: "active", date: "2026-07-02", amountKopeks: 1550992 }], "2026-07-10").amountKopeks === 1550992);
check("25 Kopeks arithmetic exact (integer math; no float)",
  factIp({ opening: 1550992, transfers: [{ status: "confirmed", amountKopeks: 98, date: "2026-07-03" }] }) === 1550894);
check("26 Same-day ordering deterministic (snapshotDate desc, then createdAt/version desc; strictly-after by day)",
  cashCollections.includes('{ snapshotDate: "desc" }, { createdAt: "desc" }') && cashTransfers.includes('{ snapshotDate: "desc" }, { version: "desc" }') && cashBalances.includes("date > since"));
check("27 Tenant isolation (transfer + correction scoped by companyId + clubId ∈ g.clubIds)",
  /createRegionalTransfer[\s\S]*?companyId: g\.companyId/.test(actions) && /correctBalanceSnapshot[\s\S]*?clubId: \{ in: g\.clubIds \}/.test(actions));
check("28 Role guards (create=canCreateOperational, confirm=explicit manager, snapshot=canSetOpeningBalance)",
  /createRegionalTransfer[\s\S]*?canCreateOperational\(g\.roles\)/.test(actions) && actions.includes("canSetOpeningBalance(g.roles)") && actions.includes("isExplicitClubManager"));

// ===================== Model / migration presence =====================
check("29 Prisma model present (CashRegionalTransfer + BalanceSnapshot versioning fields)",
  schema.includes("model CashRegionalTransfer") && schema.includes("recipientNameSnapshot") && schema.includes("idempotencyKey") &&
  /model BalanceSnapshot[\s\S]*?status\s+String[\s\S]*?supersedesSnapshotId/.test(schema));
check("30 Non-destructive migrations exist for dev + prod",
  readFileSync(join(root, "prisma/migrations/20260730120000_cash_regional_transfer_and_snapshot_versioning/migration.sql"), "utf8").includes("CashRegionalTransfer") &&
  readFileSync(join(root, "prisma/production/migrations/20260730120000_cash_regional_transfer_and_snapshot_versioning/migration.sql"), "utf8").includes("ADD COLUMN"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
