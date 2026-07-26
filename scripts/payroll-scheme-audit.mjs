// STAGE 12 pre-migration audit of EmployeePayScheme (read-only). Reports COUNTS and
// technical IDs only — no personal data, no credentials, no connection strings. Flags
// rows that need manual review before/after the backfill (spec §16/§17/§22).
//   node scripts/payroll-scheme-audit.mjs
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

const keyOf = (s) => `${s.companyId}|${s.clubId}|${s.employeeId ?? "ALL"}|${s.position ?? ""}`;
const ms = (d) => (d ? new Date(d).getTime() : null);
const LIVE = new Set(["approved", "scheduled", "active", "superseded"]);

function overlaps(a, b) {
  const aF = ms(a.effectiveFrom), aT = a.effectiveTo == null ? Infinity : ms(a.effectiveTo);
  const bF = ms(b.effectiveFrom), bT = b.effectiveTo == null ? Infinity : ms(b.effectiveTo);
  return aF < bT && bF < aT;
}

async function main() {
  const now = Date.now();
  const rows = await p.employeePayScheme.findMany({});
  const calcs = await p.payrollCalculation.findMany({ where: { schemeSnapshotJson: { not: null } }, select: { schemeSnapshotJson: true } });
  const usedIds = new Set();
  for (const c of calcs) {
    try { const s = JSON.parse(c.schemeSnapshotJson); if (s?.schemeId) usedIds.add(s.schemeId); } catch { /* ignore */ }
  }

  const byKey = new Map();
  for (const s of rows) { const k = keyOf(s); (byKey.get(k) ?? byKey.set(k, []).get(k)).push(s); }

  const problems = [];
  let overlapPairs = 0, dupVersions = 0, multiCovering = 0, noScope = 0, noCategory = 0;
  for (const [k, list] of byKey) {
    const live = list.filter((s) => LIVE.has(s.status));
    // overlapping live intervals
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      if (overlaps(live[i], live[j])) { overlapPairs++; problems.push({ type: "overlap", key: k, ids: [live[i].id, live[j].id] }); }
    }
    // duplicate version within key (after backfill this must be unique)
    const vseen = new Map();
    for (const s of list) { const v = s.version; vseen.set(v, (vseen.get(v) ?? 0) + 1); }
    for (const [v, n] of vseen) if (n > 1 && list.length > 1) { dupVersions++; problems.push({ type: "dup_version", key: k, version: v, count: n }); break; }
    // ≥2 live covering "now"
    const cov = live.filter((s) => ms(s.effectiveFrom) <= now && (s.effectiveTo == null || ms(s.effectiveTo) > now));
    if (cov.length >= 2) { multiCovering++; problems.push({ type: "multi_covering_now", key: k, ids: cov.map((s) => s.id) }); }
    // scope integrity
    for (const s of list) {
      if (!s.companyId || !s.clubId) { noScope++; problems.push({ type: "missing_scope", id: s.id }); }
      if (!s.employeeId && !s.position) { noCategory++; problems.push({ type: "no_category_or_employee", id: s.id }); }
    }
  }

  const pending = await p.payrollChangeRequest.count({ where: { requestType: "future_scheme_change", status: "approved_pending_scheme_creation" } });

  console.log("=== payroll:scheme-audit (read-only) ===");
  console.log(`schemes total            : ${rows.length}`);
  console.log(`logical keys             : ${byKey.size}`);
  console.log(`used in a snapshot       : ${rows.filter((s) => usedIds.has(s.id)).length} (immutable)`);
  console.log(`all-v1 (need backfill)   : ${rows.filter((s) => s.version === 1).length}`);
  console.log(`overlap pairs (live)     : ${overlapPairs}  <- manual review`);
  console.log(`duplicate versions       : ${dupVersions}  <- manual review`);
  console.log(`multi-covering now       : ${multiCovering}  <- resolver conflict`);
  console.log(`missing company/club     : ${noScope}`);
  console.log(`no category & no employee: ${noCategory}  <- cannot resolve`);
  console.log(`pending materialization  : ${pending} change request(s)`);
  console.log(`manual-review items      : ${problems.length}`);
  if (problems.length) console.log(JSON.stringify(problems.slice(0, 50), null, 2));
  await p.$disconnect();
  // Non-zero exit if hard conflicts exist (overlaps / multi-covering / no-scope).
  process.exit(overlapPairs + multiCovering + noScope > 0 ? 2 : 0);
}
main();
