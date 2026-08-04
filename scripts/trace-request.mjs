// REM-07 — READ-ONLY request trace (spec §25). Reconstructs the SAFE chain for a
// requestId: every SecurityEvent that carries it, in order. SELECT-only; no secrets/
// raw payload. Support pastes the code the user reported.
//   node --env-file=.env scripts/trace-request.mjs -- <requestId> [--json]
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const JSON_ONLY = process.argv.includes("--json");
const requestId = process.argv.filter((a) => !a.startsWith("--") && a !== "--").slice(2)[0];

function clean(v, max = 300) {
  if (v == null) return null;
  let out = "";
  for (let i = 0; i < String(v).length && out.length < max; i++) { const c = String(v).charCodeAt(i); out += c < 0x20 || c === 0x7f ? " " : String(v)[i]; }
  return out.trim();
}

async function main() {
  if (!requestId) { console.error("usage: trace:request -- <requestId>"); process.exit(2); }
  const events = await prisma.securityEvent.findMany({ where: { requestId }, orderBy: { createdAt: "asc" } });
  const safe = events.map((e) => ({ at: e.createdAt.toISOString(), eventType: e.eventType, severity: e.severity, outcome: e.outcome, reasonCode: e.reasonCode, actorId: e.actorId, companyId: e.companyId, clubId: e.clubId, targetType: e.targetType, targetId: e.targetId, route: clean(e.route, 120), source: e.source, deploymentVersion: e.deploymentVersion, metadata: e.metadataJson ? clean(e.metadataJson) : null }));

  if (JSON_ONLY) console.log(JSON.stringify({ requestId, count: events.length, chain: safe }, null, 2));
  else {
    console.log(`Request trace — ${requestId}`);
    if (!safe.length) { console.log("  (no security events for this requestId — the request may have succeeded, or the id is unknown)"); }
    for (const e of safe) console.log(`  ${e.at}  ${e.severity.padEnd(8)} ${e.eventType.padEnd(34)} ${e.outcome} reason=${e.reasonCode ?? "-"} actor=${e.actorId ?? "-"} co=${e.companyId ?? "-"} route=${e.route ?? "-"} v=${e.deploymentVersion ?? "-"}`);
    console.log("\nNote: AuditLog (successful domain changes) has no requestId column — correlation is via SecurityEvent + actor/time.");
  }
  await prisma.$disconnect();
  process.exit(0);
}
main().catch(async (e) => { console.error("trace failed:", String(e.message || e).slice(0, 160)); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
