// REM-07 — READ-ONLY security-event query (spec §24). SELECT-only; NO writes.
// Tenant-scoped filters; output re-sanitized (the rows are already redacted at write
// time). Secrets/PII never appear.
//   node --env-file=.env scripts/audit-security-events.mjs [--company=ID] [--actor=ID] \
//        [--event-type=authz.denied_club_scope] [--severity=high] [--request-id=UUID] \
//        [--since=ISO] [--until=ISO] [--limit=N] [--json]
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const arg = (n) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=")[1] : null; };
const JSON_ONLY = process.argv.includes("--json");
const LIMIT = Number.parseInt(arg("limit") ?? "100", 10) || 100;

function clean(v, max = 200) {
  if (v == null) return null;
  let out = "";
  for (let i = 0; i < String(v).length && out.length < max; i++) { const c = String(v).charCodeAt(i); out += c < 0x20 || c === 0x7f ? " " : String(v)[i]; }
  return out.trim();
}

async function main() {
  const where = {};
  if (arg("company")) where.companyId = arg("company");
  if (arg("actor")) where.actorId = arg("actor");
  if (arg("event-type")) where.eventType = arg("event-type");
  if (arg("severity")) where.severity = arg("severity");
  if (arg("request-id")) where.requestId = arg("request-id");
  const since = arg("since"), until = arg("until");
  if (since || until) where.createdAt = { ...(since ? { gte: new Date(since) } : {}), ...(until ? { lte: new Date(until) } : {}) };

  const rows = await prisma.securityEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: LIMIT });
  const safe = rows.map((r) => ({
    createdAt: r.createdAt.toISOString(), requestId: r.requestId, eventType: r.eventType, severity: r.severity, outcome: r.outcome,
    reasonCode: r.reasonCode, actorId: r.actorId, companyId: r.companyId, clubId: r.clubId, targetType: r.targetType, targetId: r.targetId,
    route: clean(r.route, 120), source: r.source, metadata: r.metadataJson ? clean(r.metadataJson, 300) : null, deploymentVersion: r.deploymentVersion,
  }));

  // Aggregate for a quick signal.
  const byType = {}; const byActor = {};
  for (const r of rows) { byType[r.eventType] = (byType[r.eventType] || 0) + 1; if (r.actorId) byActor[r.actorId] = (byActor[r.actorId] || 0) + 1; }

  if (JSON_ONLY) console.log(JSON.stringify({ count: rows.length, byType, events: safe }, null, 2));
  else {
    console.log(`Security events — ${rows.length} row(s)${Object.keys(where).length ? " (filtered)" : ""}`);
    for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${t}`);
    console.log("");
    for (const e of safe.slice(0, 40)) console.log(`  ${e.createdAt}  ${e.severity.padEnd(8)} ${e.eventType.padEnd(34)} actor=${e.actorId ?? "-"} co=${e.companyId ?? "-"} req=${e.requestId ?? "-"} ${e.reasonCode ?? ""}`);
  }
  await prisma.$disconnect();
  process.exit(0);
}
main().catch(async (e) => { console.error("security-events query failed:", String(e.message || e).slice(0, 160)); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
