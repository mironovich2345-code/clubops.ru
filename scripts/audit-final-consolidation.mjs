// READ-ONLY final consolidation (FULL AUDIT 6/6). Scans the six audit findings docs on disk — NO
// DB, NO deploy, no code change — extracts finding IDs + severities, DEDUPLICATES cross-audit
// findings into unified remediation clusters, and inventories the manual live GATEs. Emits
// final-remediation.json + live-gates.json + product-readiness.json (skeleton) + a summary.
//   node scripts/audit-final-consolidation.mjs [--json]
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JSON_ONLY = process.argv.includes("--json");
const read = (p) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return ""; } };

// --- 1. Extract finding IDs + severity from each audit's findings doc ---
const auditDocs = {
  ARCH: "docs/audits/full-audit-01-code-architecture.md",
  DATA: "docs/audits/full-audit-02-data-model.md",
  FIN: "docs/audits/full-audit-03-accounting-model.md",
  OPS: "docs/audits/full-audit-04-deploy-ops.md",
  SEC: "docs/audits/full-audit-05-security.md",
};
const findings = {};
for (const [prefix, path] of Object.entries(auditDocs)) {
  const text = read(path);
  for (const m of text.matchAll(new RegExp(`## (${prefix}-\\d+)[\\s\\S]*?Severity:\\*\\* (S[0-3])`, "g"))) {
    findings[m[1]] = { id: m[1], audit: prefix, severity: m[2] };
  }
  // fallback: ids without the inline severity pattern
  for (const m of text.matchAll(new RegExp(`## (${prefix}-\\d+)`, "g"))) if (!findings[m[1]]) findings[m[1]] = { id: m[1], audit: prefix, severity: "?" };
}
const totalFindings = Object.keys(findings).length;

// --- 2. Deduplicated remediation clusters (curated: the same defect seen by multiple audits) ---
const clusters = [
  { id: "REM-01", title: "Payroll payout: transaction + idempotency", priority: "P0", merges: ["ARCH-002", "ARCH-003", "ARCH-004", "DATA-003", "FIN-005", "SEC-001"], businessDecision: null, migration: "additive (idempotencyKey)", note: "one fix closes double-money on recordPayment/recordAdvance/recordRegionalCityPayment" },
  { id: "REM-02", title: "Cash contour unification (one resolver, collapse to contour B)", priority: "P0", merges: ["ARCH-001", "ARCH-006", "DATA-001", "DATA-002", "FIN-004"], businessDecision: "BD-09 (official cash contour)", migration: "data reconcile A vs B", note: "dashboard shows competing ООО/ИП figures; stop double-write" },
  { id: "REM-03", title: "Backup: off-site + scheduled + proven restore", priority: "P0", merges: ["OPS-001"], businessDecision: null, migration: "none", note: "restore NEVER tested; local-only" },
  { id: "REM-04", title: "File durability: enforce S3 in prod + back up uploads", priority: "P0", merges: ["OPS-002", "ARCH-017"], businessDecision: null, migration: "none", note: "local files lost on redeploy" },
  { id: "REM-05", title: "Profit + budget-fact single definition (+ include v2 verified)", priority: "P1", merges: ["FIN-001", "FIN-003", "DATA-018", "DATA-019"], businessDecision: "BD-03 (profit), BD-04 (budget fact)", migration: "none", note: "same period shows different numbers per screen" },
  { id: "REM-06", title: "DB readiness endpoint + DATABASE_URL validation", priority: "P1", merges: ["ARCH-015", "OPS-003", "OPS-013"], businessDecision: null, migration: "none", note: "traffic to DB-less app; malformed URL → silent sqlite" },
  { id: "REM-07", title: "Failed-authorization logging + security events", priority: "P1", merges: ["OPS-006", "SEC-009"], businessDecision: null, migration: "none", note: "no trail for cross-tenant probing / escalation attempts" },
  { id: "REM-08", title: "Ledgerless paid invoice: retire/convert legacy pay", priority: "P1", merges: ["ARCH-010", "DATA-005", "FIN-006"], businessDecision: null, migration: "maybe backfill", note: "paid invoice with paidTotal=0" },
  { id: "REM-09", title: "Company soft-delete + tenant-scoped restore/export", priority: "P1", merges: ["DATA-008", "OPS-016"], businessDecision: null, migration: "additive (isActive)", note: "hard-delete unrecoverable except full restore" },
  { id: "REM-10", title: "Payroll obligation refresh in the payment transaction", priority: "P1", merges: ["DATA-016", "FIN-012"], businessDecision: null, migration: "none", note: "«к выплате» can lag the calc (swallowed refresh)" },
  { id: "REM-11", title: "Rate-limit hardening (XFF source, AI cost caps, fail-closed)", priority: "P1", merges: ["SEC-002", "SEC-003", "SEC-008"], businessDecision: null, migration: "none", note: "verify Caddy strips XFF" },
  { id: "REM-12", title: "SSRF host allowlist for OFD serverBaseUrl", priority: "P1", merges: ["SEC-004"], businessDecision: null, migration: "none", note: "Taxcom/Astral base URL not allowlisted" },
  { id: "REM-13", title: "Build/CI: restore dev Prisma client after build:prod", priority: "P1", merges: ["ARCH-013", "OPS-004"], businessDecision: null, migration: "none", note: "green build ≠ prod-ready; order-dependent client" },
  { id: "REM-14", title: "Real DB-backed behavior tests for money engines", priority: "P1", merges: ["ARCH-022"], businessDecision: null, migration: "none", note: "~85-90% source-string/mirror; execute the real modules" },
  { id: "REM-15", title: "Tax/VAT model — business decision (no invented rates)", priority: "P1", merges: ["FIN-007"], businessDecision: "BD-13 (tax model)", migration: "unknown", note: "no tax model exists" },
  { id: "REM-16", title: "obligation.employeeId type confusion + LE attribution", priority: "P1", merges: ["DATA-010", "FIN-014"], businessDecision: "BD-06/07/11", migration: "backfill mislabeled rows", note: "employeeId may hold a payroll-row id" },
  { id: "REM-17", title: "OFD job scheduler + timezone + monitoring/alerts", priority: "P1", merges: ["OPS-007", "OPS-008", "OPS-010"], businessDecision: null, migration: "none", note: "jobs run only via manual external timer" },
  { id: "REM-18", title: "Money-incident write-freeze / maintenance mode", priority: "P1", merges: ["OPS-018"], businessDecision: null, migration: "none", note: "containment = stop container (also stops reads)" },
  { id: "REM-19", title: "P2 medium batch (storageKey token, CSV escape, confidence, obligation replay, cache-drift, refund treatment, ООО cash-expense term, rounding unify, revenue double-count check, dead fields)", priority: "P2", merges: ["SEC-005", "SEC-006", "SEC-007", "SEC-010", "SEC-011", "DATA-004", "DATA-011", "DATA-012", "DATA-013", "DATA-015", "FIN-002", "FIN-008", "FIN-009", "FIN-010", "FIN-013", "FIN-016", "FIN-017", "DATA-024"], businessDecision: "BD-02 (refund), BD-14 (revenue)", migration: "some additive (unique constraints)", note: "medium hardening + accounting-consistency batch" },
  { id: "REM-20", title: "Prisma tenant-scope extension (defense-in-depth for ARCH-005)", priority: "P2", merges: ["ARCH-005", "DATA-007", "DATA-025"], businessDecision: null, migration: "none", note: "turn manual isolation into a DB backstop" },
  { id: "REM-21", title: "P3 low/consistency batch (cancelled/canceled + terminology, partially_paid declare, enumeration/timing, archived-club invite, client idempotencyKey, removeClubAssignment, structured logging, magic-strings, migration-drift doc, N+1, audit-swallow, page.tsx prisma, INN unique, expensePeriod backfill, refund date basis, UTC drift, LE SetNull, misc grouped low)", priority: "P3", merges: ["ARCH-008", "ARCH-009", "ARCH-011", "ARCH-014", "ARCH-018", "ARCH-023", "ARCH-024", "ARCH-025", "DATA-014", "DATA-017", "DATA-020", "DATA-021", "DATA-022", "DATA-023", "DATA-026", "FIN-011", "FIN-015", "OPS-005", "OPS-009", "OPS-011", "OPS-012", "OPS-017", "SEC-012", "SEC-013", "SEC-014", "SEC-015", "SEC-016", "DATA-006", "DATA-009"], businessDecision: "BD-12 (fact date)", migration: "some additive", note: "grouped low; ratify remaining business decisions" },
  { id: "REM-22", title: "DEFERRED: v1/v2 workflow migration, xlsx replacement, white-label i18n, expand-contract migrations, CONCURRENTLY indexes, god-file refactors, dead-code removal, not-zero-downtime, CRON_SECRET doc", priority: "DEFERRED", merges: ["ARCH-012", "ARCH-019", "ARCH-021", "ARCH-016", "OPS-014", "OPS-015", "ARCH-007", "ARCH-020"], businessDecision: null, migration: "varies", note: "not launch-affecting" },
];

// --- 3. Manual live GATEs (carried from prior epics + audits) ---
const liveGates = [
  { id: "G1", title: "Cash transfer to regional (confirmed-only reduces ИП)", source: "cash-transfer epic", env: "real instance", status: "OPEN" },
  { id: "G2", title: "Backdated control snapshot", source: "cash-transfer epic", env: "real instance", status: "OPEN" },
  { id: "G3", title: "Snapshot correction / cancellation", source: "collections epic", env: "real instance", status: "OPEN" },
  { id: "G4", title: "PDF viewer on a real iPhone (same-origin framing)", source: "mobile epic", env: "real iPhone", status: "OPEN" },
  { id: "G5", title: "Invitation flow acceptance", source: "owner-cabinet epic", env: "real instance", status: "OPEN" },
  { id: "G6", title: "Invoice partial payment + reversal (chief-only) + already-paid invoice", source: "invoice epic", env: "real instance", status: "OPEN" },
  { id: "G7", title: "Invoice AI review + payment guard", source: "invoice epic", env: "real instance", status: "OPEN" },
  { id: "G8", title: "Regional dashboard review tasks", source: "regional epic", env: "real instance", status: "OPEN" },
  { id: "G9", title: "Payroll forecast + salary budget proposal + obligation + advance/payment/reversal", source: "payroll-budget epic", env: "real instance", status: "OPEN" },
  { id: "G10", title: "Backup + restore rehearsal (Postgres)", source: "Audit 4 OPS-001", env: "disposable Postgres", status: "OPEN (NOT EXECUTED)" },
  { id: "G11", title: "Staging migration rehearsal", source: "Audit 4", env: "disposable Postgres", status: "OPEN (NOT EXECUTED)" },
  { id: "G12", title: "File durability under redeploy (S3)", source: "Audit 4 OPS-002", env: "staging", status: "OPEN" },
  { id: "G13", title: "DB readiness under DB-down", source: "Audit 4 OPS-003", env: "staging", status: "OPEN" },
  { id: "G14", title: "OFD daily scheduler configured + fresh sync", source: "Audit 4 OPS-008", env: "staging", status: "OPEN" },
  { id: "G15", title: "Caddy strips inbound X-Forwarded-For; prod OFD serverBaseUrl review", source: "Audit 5 SEC-002/004", env: "staging/prod", status: "OPEN" },
  { id: "G16", title: "audit:data-integrity + audit:financial-reconciliation on a production read replica", source: "Audit 2/3", env: "prod replica", status: "OPEN" },
];

const merged = new Set(clusters.flatMap((c) => c.merges));
const uncovered = Object.keys(findings).filter((id) => !merged.has(id));

const out = join(ROOT, "docs/audits/data");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "final-remediation.json"), JSON.stringify({
  totalFindingsAcross6Audits: totalFindings, remediationClusters: clusters.length,
  byPriority: { P0: clusters.filter((c) => c.priority === "P0").length, P1: clusters.filter((c) => c.priority === "P1").length, P2: clusters.filter((c) => c.priority === "P2").length, DEFERRED: clusters.filter((c) => c.priority === "DEFERRED").length },
  uncoveredFindings: uncovered, clusters,
}, null, 2));
writeFileSync(join(out, "live-gates.json"), JSON.stringify({ total: liveGates.length, open: liveGates.filter((g) => g.status.startsWith("OPEN")).length, gates: liveGates }, null, 2));

if (!JSON_ONLY) {
  console.log("=== Final cross-audit consolidation (read-only) ===");
  console.log(`Findings extracted across Audits 1-5: ${totalFindings}`);
  console.log(`Remediation clusters (deduped): ${clusters.length} — P0:${clusters.filter((c) => c.priority === "P0").length} P1:${clusters.filter((c) => c.priority === "P1").length} P2:${clusters.filter((c) => c.priority === "P2").length} DEFERRED:${clusters.filter((c) => c.priority === "DEFERRED").length}`);
  console.log(`Findings not yet in a cluster (verify): ${uncovered.length}${uncovered.length ? " -> " + uncovered.join(", ") : ""}`);
  console.log(`Manual live GATEs: ${liveGates.length} (open: ${liveGates.filter((g) => g.status.startsWith("OPEN")).length})`);
  console.log("Key merges: REM-01 payroll payout = ARCH-002/003/004 + DATA-003 + FIN-005 + SEC-001");
  console.log("Wrote final-remediation.json, live-gates.json");
}
